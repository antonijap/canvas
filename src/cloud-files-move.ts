// A move keeps its source until the destination's document and every asset have been downloaded and verified.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkBlobPath, blobTypeOf, type BlobPath, type FileOp, type Json } from '../cloud/protocol-files.ts';
import { asCommentsFile, MAX_COMMENTS_BYTES } from './comments-file.ts';
import { opsForShare } from './cloud-sync.ts';
import { voterId, voteOpsForMove, voteTopology } from './vote-state.ts';
import { voteDesignForTopology } from '../cloud/core/votes.ts';
import { openInPackage } from '../cloud/core/files/confine.ts';
import { logPathOf, tieOf, withLog } from './doc/doclog.ts';
import { UPLOAD_LIMITS } from '../cloud/core/files/uploads.ts';
import { stripPageAppearance } from '../cloud/core/files/state.ts';
import { trashPackage } from './cloud-files-trash.ts';
import { readMoveAsset, readPackageFile, withPackageFile } from './cloud-files-assets.ts';
export class MovePendingError extends Error {
    readonly status = 409;
    readonly code = 'move_pending';
}

export interface MoveBlob {
    op: Extract<FileOp, {
        k: 'blob';
    }>;
    bytes: Buffer;
}
export function movePackagePath(source: string): string {
    const file = path.resolve(source);
    const parent = path.dirname(file);
    return path.basename(file) === 'document.json' && parent.endsWith('.canvas') ? parent : file;
}

const activeMoveStages = new Set<string>();
export function stageMove(target: string): string {
    const parent = fs.realpathSync(path.dirname(target));
    const stage = fs.mkdtempSync(path.join(parent, '.canvas-move-'));
    activeMoveStages.add(stage);
    return stage;
}

export function finishMoveStage(stage: string) {
    activeMoveStages.delete(stage);
    try { fs.rmdirSync(stage); } catch { /* Startup can recover a remaining package. */ }
}

export function restoreMovedPackage(parked: string): string {
    const dir = path.dirname(path.dirname(parked));
    const name = path.basename(parked, '.canvas');
    for (let i = 0; ; i++) {
        const label = i === 0 ? name : i === 1 ? `${name} Recovered` : `${name} Recovered ${i}`;
        const target = path.join(dir, label + '.canvas');
        if (fs.lstatSync(target, { throwIfNoEntry: false })) continue;
        try {
            fs.renameSync(parked, target);
            return target;
        } catch (error) {
            if (!fs.lstatSync(target, { throwIfNoEntry: false })) throw error;
        }
    }
}

export function recoverMoveStages(dir: string, entries = fs.readdirSync(dir, { withFileTypes: true })) {
    dir = fs.realpathSync(dir);
    for (const entry of entries) {
        if (!entry.isDirectory() || !/^\.canvas-move-[a-z0-9]{6}$/i.test(entry.name)) continue;
        const stage = path.join(dir, entry.name);
        if (activeMoveStages.has(stage)) continue;
        try {
            for (const item of fs.readdirSync(stage, { withFileTypes: true })) {
                if (!item.isDirectory() || !item.name.endsWith('.canvas')) continue;
                const parked = path.join(stage, item.name);
                if (fs.lstatSync(path.join(parked, 'document.json'), { throwIfNoEntry: false })?.isFile())
                    restoreMovedPackage(parked);
            }
            fs.rmdirSync(stage);
        } catch { /* Leave inaccessible packages for the next startup. */ }
    }
}

export async function prepareMove(source: string, publish: (name: string, doc: Record<string, Json>, envelope: Record<string, Json>, blobs: MoveBlob[], comments: ReturnType<typeof opsForShare>) => Promise<{
    id: string;
    file: string;
    name: string;
    cloud: string;
    role: string;
}>, finalize?: (destination: { id:string; file:string; name:string; cloud:string; role:string }) => Promise<void>) {
    const pkg = movePackagePath(source);
    const sourceStat = fs.lstatSync(pkg);
    if (!pkg.endsWith('.canvas') || !sourceStat.isDirectory())
        throw new Error('Move a local Canvas package');
    const chunk = Buffer.allocUnsafe(64 * 1024);
    const fingerprint = (dir: string, root = dir): string => {
        const hash = createHash('sha256');
        for (const name of fs.readdirSync(dir).sort()) {
            const file = path.join(dir, name), stat = fs.lstatSync(file);
            if (!stat.isDirectory() && !stat.isFile()) throw new Error('Move refuses linked or non-regular files');
            const digest = stat.isDirectory() ? fingerprint(file, root)
                : withPackageFile(root, path.relative(root, file), fd => {
                    const content = createHash('sha256');
                    for (let count; (count = fs.readSync(fd, chunk, 0, chunk.length, null));)
                        content.update(chunk.subarray(0, count));
                    return content.digest('hex');
                });
            hash.update(JSON.stringify([name, stat.isDirectory(), digest]));
        }
        return hash.digest('hex');
    };
    const sourceHash = fingerprint(pkg);
    for(const name of ['document.json','widgets.json','comments.json']){const stat=fs.lstatSync(path.join(pkg,name),{throwIfNoEntry:false});if(stat&&(stat.isSymbolicLink()||stat.nlink!==1))throw new Error('Move refuses linked document files');}
    const docPath = path.join(pkg, 'document.json');
    const logName = path.basename(logPathOf(docPath));
    const log = fs.lstatSync(path.join(pkg, logName), { throwIfNoEntry: false })
        ? withPackageFile(pkg, logName, fd => {
            const raw = fs.readFileSync(fd);
            return { raw, sig: `${fs.fstatSync(fd).ino}:${raw.length}` };
        }) : null;
    const doc = withPackageFile(pkg, 'document.json', fd => {
        const raw = fs.readFileSync(fd);
        const state = JSON.parse(raw.toString());
        if (!log) return state;
        const loaded = withLog(docPath, createHash('sha256').update(raw).digest('hex'), state, log, tieOf(fs.fstatSync(fd)));
        if (loaded.unknown || (loaded.stale && !loaded.folded) || (loaded.log && loaded.log.size < log.raw.length))
            throw new Error('Resolve the local save log before moving this file');
        return loaded.doc;
    });
    const widgetsPath = path.join(pkg, 'widgets.json');
    const widgetsBefore = fs.existsSync(widgetsPath) ? readPackageFile(pkg, 'widgets.json').toString() : '{"widgets":[]}';
    const env = JSON.parse(widgetsBefore);
    if (Object.hasOwn(env, 'pages')) env.pages = stripPageAppearance(env.pages);
    const blobs = new Map<string, MoveBlob>();
    const rewrites = new Map<string, string>();
    let assetBytes = 0;
    const addBlob = (rel: string, bytes: Buffer) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const previous = blobs.get(rel);
        if (previous && previous.op.sha256 !== sha256) throw new Error('Move refused: asset paths collide');
        if (!previous) {
            assetBytes += bytes.length;
            if (assetBytes > UPLOAD_LIMITS.file) throw new Error('A Cloud file holds up to 1 GB of assets');
            const blobPath = rel as BlobPath;
            blobs.set(rel, { op: { k: 'blob', path: blobPath, sha256, bytes: bytes.length, type: blobTypeOf(blobPath) }, bytes });
        }
    };
    const addAsset = (ref: string, folder: string) => {
        const ext = path.extname(ref).toLowerCase();
        const canonical = checkBlobPath(ref) !== null;
        if (canonical && checkBlobPath(`${folder}/import${ext}`)) throw new Error('Move refused: unsupported media type');
        const stat = !canonical ? fs.lstatSync(path.join(pkg, ref), { throwIfNoEntry: false }) : undefined;
        if (stat && stat.size > Math.min(UPLOAD_LIMITS.image, UPLOAD_LIMITS.file - assetBytes))
            throw new Error('A Cloud move exceeds the size limit');
        let bytes: Buffer;
        if (canonical) bytes = readMoveAsset(pkg, ref);
        else {
            const opened = openInPackage(pkg, ref, fs);
            if ('refused' in opened) throw new Error(opened.refused);
            try { bytes = fs.readFileSync(opened.fd); }
            finally { fs.closeSync(opened.fd); }
        }
        const rel = canonical ? `${folder}/${createHash('sha256').update(bytes).digest('hex')}${ext}` : ref;
        addBlob(rel, bytes);
        rewrites.set(ref, rel);
        return rel;
    };
    const collect = (folder: string, parent: string) => {
        for (const entry of fs.readdirSync(path.join(pkg, parent), { withFileTypes: true })) {
            const name = entry.name;
            if (entry.isSymbolicLink()) throw new Error('Move refuses linked asset folders or files');
            if (name === '.DS_Store' || (parent === 'media' && entry.isDirectory() && ['posters', 'proxies'].includes(name))
                || (folder === 'shaders' && /\.poster-[a-z0-9]+\.png$/.test(name))) continue;
            const rel = `${parent}/${name}`;
            if (entry.isDirectory()) collect(folder, rel);
            else addAsset(rel, folder);
        }
    };
    for (const folder of ['media', 'shaders', 'fonts']) {
        const stat = fs.lstatSync(path.join(pkg, folder), { throwIfNoEntry: false });
        if (!stat) continue;
        if (!stat.isDirectory()) throw new Error('Move requires real asset folders');
        collect(folder, folder);
    }
    const assetRef = (ref: string, folder = path.extname(ref).toLowerCase() === '.wgsl' ? 'shaders' : 'media'): string => {
        if (/^data:/i.test(ref)) return ref;
        if (!checkBlobPath(ref)) return ref;
        return rewrites.get(ref) ?? addAsset(ref, folder);
    };
    // Data images become content addressed package assets; external URLs are refused without fetching them.
    const walk = (v: any) => {
        if (!v || typeof v !== 'object')
            return;
        if(typeof v.scriptUri==='string')v.scriptUri=assetRef(v.scriptUri);
        if(v.config&&typeof v.config==='object') {
            const key = v.kind === 'video' ? 'src' : v.kind === 'shader' ? 'source' : null;
            if(key && typeof v.config[key]==='string')v.config[key]=assetRef(v.config[key]);
        }
        if (v.type === 'image' && typeof v.url === 'string') {
            if (/^https?:/i.test(v.url))
                throw new Error('Cloud files refuse http(s) image fills');
            v.url=assetRef(v.url);
            const data = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,([A-Za-z0-9+/=\s]+)$/.exec(v.url);
            if (data) {
                const bytes = Buffer.from(data[2], 'base64'), sha256 = createHash('sha256').update(bytes).digest('hex'), ext = ({ jpeg: 'jpg', 'svg+xml': 'svg' } as any)[data[1]] ?? data[1], rel = `media/${sha256}.${ext}` as BlobPath;
                addBlob(rel, bytes);
                v.url = rel;
            }
        }
        for (const child of Object.values(v))
            walk(child);
    };
    if(Array.isArray(doc.fonts))for(const f of doc.fonts)for(const key of ["url","file","src"])if(typeof f[key]==='string')f[key]=assetRef(f[key], 'fonts');
    walk(doc);
    walk(env);
    const commentStat = fs.lstatSync(path.join(pkg, 'comments.json'), { throwIfNoEntry: false });
    const comments = commentStat && commentStat.size <= MAX_COMMENTS_BYTES
        ? asCommentsFile(JSON.parse(readPackageFile(pkg, 'comments.json').toString())) : null;
    if (commentStat && !comments) throw new Error('Move requires a valid comments.json');
    const voting = (comments?.votes?.length || comments?.timer)
        ? voteOpsForMove(comments, voterId(), voteDesignForTopology(voteTopology(path.join(pkg, 'document.json'), doc)))
        : { ops: [] };
    const dest = await publish(path.basename(pkg, '.canvas'), doc, env, [...blobs.values()], comments ? [...opsForShare(comments), ...voting.ops] : []);
    const actual = JSON.parse(fs.readFileSync(path.join(dest.file, 'document.json'), 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(doc))
        throw new Error('Move verification failed: document differs');
    const actualEnv = JSON.parse(fs.readFileSync(path.join(dest.file, 'widgets.json'), 'utf8'));
    for (const [key, value] of Object.entries(env))
        if (key !== 'version' && JSON.stringify(actualEnv[key]) !== JSON.stringify(value))
            throw new Error('Move verification failed: ' + key + ' differs');
    for (const b of blobs.values()) {
        const bytes = fs.readFileSync(path.join(dest.file, b.op.path));
        if (createHash('sha256').update(bytes).digest('hex') !== b.op.sha256)
            throw new Error('Move verification failed: blob hash differs');
    }
    if (fingerprint(pkg) !== sourceHash) throw new Error('Local file changed during the move; source kept');
    // The local file stays visible through a lost reply or a crash before publication.
    await finalize?.(dest);
    const sameSource = (file: string) => {
        const st = fs.lstatSync(file, { throwIfNoEntry: false });
        return !!st?.isDirectory() && st.dev === sourceStat.dev && st.ino === sourceStat.ino;
    };
    let stage: string | undefined, parked: string | undefined;
    try {
        if (!sameSource(pkg)) return { ...dest, verified: true, notice: 'The local path changed during the move.' };
        stage = stageMove(pkg);
        parked = path.join(stage, path.basename(pkg));
        fs.renameSync(pkg, parked);
        let unchanged = false;
        try { unchanged = sameSource(parked) && fingerprint(parked) === sourceHash; }
        catch { /* Keep a source whose contents can no longer be verified. */ }
        if (!unchanged) {
            const restored = restoreMovedPackage(parked);
            return { ...dest, verified: true, notice: `Local changes were kept at ${restored}` };
        }
        trashPackage(parked);
    } catch {
        const kept = parked && fs.existsSync(parked) ? parked : pkg;
        return { ...dest, verified: true, notice: `The local source was kept at ${kept}` };
    } finally {
        if (stage) finishMoveStage(stage);
    }
    return { ...dest, verified: true, notice: voting.notice };
}
