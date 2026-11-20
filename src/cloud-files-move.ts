// A move keeps its source until the destination's document and every asset have been downloaded and verified.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { checkBlobPath, blobTypeOf, type BlobPath, type FileOp, type Json } from '../cloud/protocol-files.ts';
import { readCommentsFile } from './comments-file.ts';
import { opsForShare } from './cloud-sync.ts';
import { openInPackage } from '../cloud/core/files/confine.ts';
import { trashPackage } from './cloud-files-trash.ts';
import { readMoveAsset } from './cloud-files-assets.ts';
export interface MoveBlob {
    op: Extract<FileOp, {
        k: 'blob';
    }>;
    bytes: Buffer;
    source?: string;
}
export async function prepareMove(source: string, publish: (name: string, doc: Record<string, Json>, envelope: Record<string, Json>, blobs: MoveBlob[], comments: ReturnType<typeof opsForShare>) => Promise<{
    id: string;
    file: string;
    name: string;
    cloud: string;
    role: string;
}>, finalize?: (destination: { id:string; file:string; name:string; cloud:string; role:string }) => Promise<void>) {
    const pkg = path.resolve(source);
    if (!pkg.endsWith('.canvas') || fs.lstatSync(pkg).isSymbolicLink() || !fs.statSync(pkg).isDirectory())
        throw new Error('Move a local Canvas package');
    const fingerprint = (dir: string): string => {
        const hash = createHash('sha256');
        for (const name of fs.readdirSync(dir).sort()) {
            const file = path.join(dir, name), stat = fs.lstatSync(file);
            hash.update(name).update('\0');
            if (stat.isSymbolicLink()) throw new Error('Local file changed during the move; source kept');
            hash.update(stat.isDirectory() ? fingerprint(file) : fs.readFileSync(file));
        }
        return hash.digest('hex');
    };
    const sourceHash = fingerprint(pkg);
    for(const name of ['document.json','widgets.json','comments.json']){const stat=fs.lstatSync(path.join(pkg,name),{throwIfNoEntry:false});if(stat&&(stat.isSymbolicLink()||stat.nlink!==1))throw new Error('Move refuses linked document files');}
    const commentsPath=path.join(pkg,'comments.json');const commentsBefore=fs.existsSync(commentsPath)?fs.readFileSync(commentsPath,'utf8'):null;
    const original = fs.readFileSync(path.join(pkg, 'document.json'), 'utf8');
    const widgetsPath = path.join(pkg, 'widgets.json');
    const widgetsBefore = fs.existsSync(widgetsPath) ? fs.readFileSync(widgetsPath, 'utf8') : '{"widgets":[]}';
    const doc = JSON.parse(original), env = JSON.parse(widgetsBefore);
    const blobs: MoveBlob[] = [];
    const rewrites=new Map<string,string>();
    for (const dir of ['media', 'shaders']) {
        if (!fs.existsSync(path.join(pkg, dir)))
            continue;
        if (fs.lstatSync(path.join(pkg, dir)).isSymbolicLink())
            throw new Error('Media folder is a link');
        for (const name of fs.readdirSync(path.join(pkg, dir))) {
            if(name==='.DS_Store'||(dir==='media'&&['posters','proxies'].includes(name))||(dir==='shaders'&&/\.poster-[a-z0-9]+\.png$/.test(name)))continue;
            const old=dir+'/'+name,abs=path.join(pkg,dir,name),probe=checkBlobPath(old)?dir+'/import'+path.extname(name).toLowerCase():old;
            if(checkBlobPath(probe))throw new Error('Move refused: unsupported media type');
            const alias=(p:string)=>p===path.join(pkg,probe)?abs:p;
            const opened = openInPackage(pkg,probe,{constants:fs.constants,lstatSync:p=>fs.lstatSync(alias(p)),fstatSync:fs.fstatSync,closeSync:fs.closeSync,openSync:(p,flags)=>fs.openSync(alias(p),flags),realpathSync:p=>fs.realpathSync(alias(p))});
            if ('refused' in opened)
                throw new Error(opened.refused);
            let bytes: Buffer;
            try {
                bytes = fs.readFileSync(opened.fd);
            }
            finally {
                fs.closeSync(opened.fd);
            }
            const sha256=createHash('sha256').update(bytes).digest('hex'),rel=checkBlobPath(old)?dir+'/'+sha256+path.extname(name).toLowerCase():old;if(rel!==old)rewrites.set(old,rel);
            blobs.push({ op: { k: 'blob', path: rel as BlobPath, sha256, bytes: bytes.length, type: blobTypeOf(rel as BlobPath) }, bytes, source:abs });
        }
    }
    const assetRef = (ref: string): string => {
        if (rewrites.has(ref)) return rewrites.get(ref)!;
        if (!checkBlobPath(ref) || /^data:/i.test(ref)) return ref;
        const ext = path.extname(ref).toLowerCase();
        const folder = ext === '.wgsl' ? 'shaders' : 'media';
        if (checkBlobPath(`${folder}/import${ext}`)) throw new Error('Move refused: unsupported media type');
        const bytes = readMoveAsset(pkg, ref), sha256 = createHash('sha256').update(bytes).digest('hex');
        const rel = `${folder}/${sha256}${ext}` as BlobPath;
        if (!blobs.some(b => b.op.path === rel))
            blobs.push({ op: { k: 'blob', path: rel, sha256, bytes: bytes.length, type: blobTypeOf(rel) }, bytes, source: path.join(pkg, ref) });
        rewrites.set(ref, rel);
        return rel;
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
                blobs.push({ op: { k: 'blob', path: rel, sha256, bytes: bytes.length, type: blobTypeOf(rel) }, bytes });
                v.url = rel;
            }
        }
        for (const child of Object.values(v))
            walk(child);
    };
    if(Array.isArray(doc.fonts))for(const f of doc.fonts)for(const key of ["url","file","src"])if(typeof f[key]==='string')f[key]=assetRef(f[key]);
    walk(doc);
    walk(env);
    const comments = readCommentsFile(pkg);
    const dest = await publish(path.basename(pkg, '.canvas'), doc, env, blobs, comments ? opsForShare(comments) : []);
    const actual = JSON.parse(fs.readFileSync(path.join(dest.file, 'document.json'), 'utf8'));
    if (JSON.stringify(actual) !== JSON.stringify(doc))
        throw new Error('Move verification failed: document differs');
    const actualEnv = JSON.parse(fs.readFileSync(path.join(dest.file, 'widgets.json'), 'utf8'));
    for (const [key, value] of Object.entries(env))
        if (key !== 'version' && JSON.stringify(actualEnv[key]) !== JSON.stringify(value))
            throw new Error('Move verification failed: ' + key + ' differs');
    for (const b of blobs) {
        const bytes = fs.readFileSync(path.join(dest.file, b.op.path));
        if (createHash('sha256').update(bytes).digest('hex') !== b.op.sha256)
            throw new Error('Move verification failed: blob hash differs');
    }
    if (fs.readFileSync(path.join(pkg, 'document.json'), 'utf8') !== original)
        throw new Error('The local file changed during the move; kept it here');
    if ((fs.existsSync(widgetsPath) ? fs.readFileSync(widgetsPath, 'utf8') : '{"widgets":[]}') !== widgetsBefore)
        throw new Error('Local widgets changed during the move');
    for (const b of blobs)
        if (b.source && (!fs.existsSync(b.source)||createHash('sha256').update(fs.readFileSync(b.source)).digest('hex') !== b.op.sha256))
            throw new Error('Local media changed during the move');
    if((fs.existsSync(commentsPath)?fs.readFileSync(commentsPath,'utf8'):null)!==commentsBefore)throw new Error('Local comments changed during the move; source kept');
    await finalize?.(dest);
    // No await between this final source check and the recoverable rename.
    if (fingerprint(pkg) !== sourceHash) throw new Error('Local file changed during the move; source kept');
    trashPackage(pkg);
    return { ...dest, verified: true };
}
