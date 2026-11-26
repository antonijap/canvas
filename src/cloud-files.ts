import { evictClosedPackages } from "./cloud-files-cache.ts";
import { importDocument } from "./cloud-files-import.ts";
// Open Cloud files have one durable replica and one socket. Confirmed state never contains speculative edits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type http from 'node:http';
import { target } from './cloud.ts';
import { cloudConfigs, onCloudsChanged, isConfigured, generation, bump, hostedId, waitForShellCloudList } from './cloud-config.ts';
import { FileStateStore } from './cloud-files-store.ts';
import { DocTree } from './cloud-files-tree.ts';
import { documentOf, envelopeOf } from '../cloud/core/files/state.ts';
import { cloudFileHooks } from './cloud-files-runtime.ts';
import { asOneAction, adoptWriters, onAction, envelopeFileOps, usesExtendedBlobPaths } from './cloud-files-ops.ts';
import { loadManifest, type Manifest } from '../cloud/core/files/snapshots.ts';
import { type ObjectStore, fromUtf8 } from '../cloud/core/files/objects.ts';
import { FILE_TRANSFER, FILE_TRANSFER_PARTS, TRANSFER_HEADER_BYTES, TRANSFER_PART_BYTES, blobBatches } from '../cloud/file-transfer.ts';
import { O_NOFOLLOW_ANY, openInPackage } from '../cloud/core/files/confine.ts';
import { type Action, type FileServerMessage, type FileOp, type Role, CAN_EDIT, checkBlobPath, EXTENDED_BLOB_PATHS, FILE_CAPABILITIES_HEADER, hasWhiteboard, insertsWhiteboard, safeBlobPath, supportsWhiteboard, UPDATE_BLOB_PATHS_HOST, UPDATE_WHITEBOARD_HOST, WHITEBOARD } from '../cloud/protocol-files.ts';
import { createPackage, targetPath } from './docpath.ts';
import { type BlobRow } from '../cloud/core/files/seam.ts';
import { readBodyText } from './body.ts';
import { applyOp, VOTE_CLIENT_CAPABILITIES, isRateRefusal, isVoteOp, LIMITS, needsCloudTimers, supportsCloudTimers, supportsCloudVotes, supportsPrivateVoteViews, UPDATE_TIMER_HOST, UPDATE_COMMENT_HOST, UPDATE_VOTE_HOST, type CommentsFile, type OpEnvelope, type Rejected, type StandaloneTimer, type Thread, type Vote, type VoteView } from '../cloud/protocol.ts';
import { COMMENTS_FILE, emptyComments, forkComments, readCommentsFile, writeCommentsFile } from './comments-file.ts';
import { anchorVoteClock, ownLocalVotes, receiveVoteViews, sendableCommentOps, voteOpsForTransfer, voteServerTime, type VoteClock } from './vote-state.ts';
import { finishMoveStage, MovePendingError, movePackagePath, prepareMove, restoreMovedPackage, stageMove, type MoveBlob } from './cloud-files-move.ts';
import { checkPresence, stripIdentity, keep, type Presence, type PeerPresence } from '../cloud/core/presence.ts';
import { createPresenceSender } from './page/presence-client.js';
import { pendingStates, retry, discard, type RefusedOp } from './cloud-sync.ts';
import { unreadThreads } from './comment-reads.ts';
async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
    if (Number(response.headers.get('content-length')) > limit) {
        await response.body?.cancel();
        throw new Error('Cloud response exceeds its byte limit');
    }
    const reader = response.body?.getReader();
    if (!reader)
        return new Uint8Array();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
        for (;;) {
            const { value, done } = await reader.read();
            if (done)
                break;
            size += value.length;
            if (size > limit)
                throw new Error('Cloud response exceeds its byte limit');
            chunks.push(value);
        }
    }
    finally {
        await reader.cancel().catch(() => { });
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const c of chunks) {
        out.set(c, at);
        at += c.length;
    }
    return out;
}
const cloudJson = async (response: Response) => JSON.parse(new TextDecoder().decode(await boundedBytes(response, 8 * 1024 * 1024)));
const SHA = /^[0-9a-f]{64}$/, UUID = /^[0-9a-f-]{36}$/;
export const cloudKey = (url: string) => createHash('sha256').update(url).digest('hex').slice(0, 16);
const root = () => path.join(fs.realpathSync(os.homedir()), 'Library', 'Application Support', 'Canvas', 'cloud-files');
const resolveCloud = (cloud: string) => cloudConfigs().find(c => c.url === cloud || cloudKey(c.url) === cloud)?.url ?? fail(404, 'not_found', 'Cloud is not added');
const fail = (status: number, code: string, message: string): never => { throw Object.assign(new Error(message), { status, code }); };
const committingMoves = new Set<string>();
const movingSources = new Set<string>();
function requireStationaryFile(file: string) {
    if (committingMoves.size && committingMoves.has(docFile(file))) fail(409, 'moving', 'This file is being moved');
}
interface Session {
    store: FileStateStore;
    ws?: WebSocket;
    connecting?: boolean;
    initialConnect?: Promise<'missing' | void>;
    importing?: boolean;
    status: string;
    whiteboard?: boolean;
    extendedBlobPaths?: boolean;
    assetNotice?: string;
    voting?: boolean;
    timerCapable?: boolean;
    cloudTimer?: StandaloneTimer | null;
    voteClock?: VoteClock;
    leasedConclusions?: boolean;
    cloudVotes?: VoteView[];
    voteConclusions?: string[];
    legacyVotes?: Vote[];
    legacyVoteConclusions?: string[];
    commentsInFlight?: Set<string>;
    updateMessage?: string;
    timer?: NodeJS.Timeout;
    retryDelay?: number;
    chain: Promise<unknown>;
    stopped: boolean;
    offline: boolean;
    comments: Thread[];
    commentsSeq: number;
    commentsPending: OpEnvelope[];
    commentsRejected?: RefusedOp[];
    recovery?: string;
    presenceSender?: ReturnType<typeof createPresenceSender>;
    peers?: Map<string, PeerPresence>;
}
const sessions = new Map<string, Session>();
const checkpointSession=(s:Session)=>{
    s.store.checkpoint(path.join(os.homedir(),"Library","Caches","Canvas","cloud",cloudKey(s.store.meta.cloud),"boards"));
    evictClosedPackages(root(),new Set([...sessions.values()].map(s=>s.store.pkg)));
};
const revoked = new Set<string>();
export const fileEvents: {
    problem?: (message: string) => void;
    update?: (file: string, message: string) => void;
    view?: (file: string) => void;
    removed?: (file: string) => void;
    comments?: (file: string) => void;
    presence?: (file: string, peers: PeerPresence[]) => void;
} = {};
export const filePeers = (file: string) => [...(fileSession(file)?.peers?.values() ?? [])];
export function sendFilePresence(file: string, patch: unknown): boolean {
    const s = fileSession(file), p = stripIdentity(patch);
    if (!s || s.stopped || s.offline || checkPresence(p)) return false;
    s.presenceSender ??= createPresenceSender({ send: p => {
        if (!s.stopped && s.status === 'connected' && s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ type: 'presence', p }));
    } });
    s.presenceSender.update(p as Presence);
    return true;
}
function clearPresence(s: Session) {
    s.presenceSender?.dispose(); s.presenceSender = undefined;
    const gone = [...(s.peers?.values() ?? [])].map(p => ({ ...p, gone: true as const }));
    s.peers?.clear();
    if (gone.length) fileEvents.presence?.(path.join(s.store.pkg, 'document.json'), gone);
}
function docFile(file: string) {
    const f = file.endsWith('document.json') ? path.resolve(file) : path.join(path.resolve(file), 'document.json');
    return fs.existsSync(f) ? fs.realpathSync(f) : f;
}
export function waitForCachedCloudSettings(file: string): Promise<void> | undefined {
    const prefix = root() + path.sep;
    const pkg = path.resolve(file);
    if (!pkg.startsWith(prefix)) return;
    const key = pkg.slice(prefix.length).split(path.sep, 1)[0];
    if (cloudConfigs().some(c => cloudKey(c.url) === key)) return;
    if (fs.existsSync(path.join(path.dirname(docFile(pkg)), '.cloud', 'state.sqlite'))) return waitForShellCloudList();
}
export function fileSession(file: string, importing = false, deferConnect = false): Session | undefined {
    const f = docFile(file);
    let s = sessions.get(f);
    if (s) {
        if (importing) s.importing = true;
        return s;
    }
    if (!f.startsWith(root() + path.sep) || !fs.existsSync(path.join(path.dirname(f), '.cloud', 'state.sqlite')))
        return;
    const store = new FileStateStore(path.dirname(f));
    if (!isConfigured(store.meta.cloud)) {
        store.close();
        fail(403, 'removed', 'This Cloud is not added');
    }
    s = { store, importing, status: 'offline', chain: Promise.resolve(), stopped: false, offline: false, comments: [], commentsSeq: 0, commentsPending: [] };
    store.db.exec('CREATE TABLE IF NOT EXISTS comments_state(id INTEGER PRIMARY KEY CHECK(id=1),json TEXT NOT NULL)');
    const c = store.db.prepare('SELECT json FROM comments_state WHERE id=1').get();
    const saved = c && JSON.parse(String(c.json));
    if (saved) Object.assign(s, saved);
    if (saved?.voteQueueVersion !== 1) {
        s.commentsPending = s.commentsPending.filter(e => !isVoteOp(e.op));
        s.commentsRejected = s.commentsRejected?.filter(r => !isVoteOp(r.envelope.op));
        const legacy = readCommentsFile(store.pkg);
        s.legacyVotes = legacy?.votes?.filter(v => v.state !== 'dismissed').map(v =>
            v.state === 'active' && (v.hidden || v.anonymous) ? ownLocalVotes([v])[0] : v);
        s.legacyVoteConclusions = legacy?.voteConclusions?.filter(id => s.legacyVotes?.some(v => v.id === id));
        s.voteConclusions = s.voteConclusions?.filter(id => !s.legacyVotes?.some(v => v.id === id));
        // The old queue may have come from a copied package. Keep local history, never replay that queue.
        if (legacy || saved) saveComments(s);
    }
    sessions.set(f, s);
    store.restoreView();
    checkpointSession(s);
    if (!deferConnect) s.initialConnect = connect(s);
    return s;
}
cloudFileHooks.isCloud = f => !!fileSession(f);
cloudFileHooks.info = fileInfo;
cloudFileHooks.undoConflict = (file, writers) => {
    const s=fileSession(file); if(!s)return;
    const tree=s.store.replica.view(), names=new Set<string>();
    let changed=false;
    for(const [target, expected] of Object.entries(writers)) {
        const writer=tree.ver(target); if(writer===expected)continue;
        changed=true;
        const row=writer ? s.store.db.prepare("SELECT action_json FROM confirmed WHERE json_extract(action_json,'$.id')=? LIMIT 1").get(writer) : null;
        if(row) names.add(JSON.parse(String(row.action_json)).by.name || 'Someone');
    }
    return changed ? [...names].slice(0,3).join(', ') || 'Someone' : undefined;
};
cloudFileHooks.assertEdit = f => {
    requireStationaryFile(f);
    const s = fileSession(f);
    if (s?.updateMessage) fail(426, 'update', s.updateMessage);
    if (s && !CAN_EDIT[s.store.meta.role]) fail(403, 'read_only', 'This Cloud file is read only');
};
cloudFileHooks.whiteboardIssue = (file, nodes) => {
    const s = fileSession(file);
    return s && s.whiteboard !== true && hasWhiteboard(nodes) ? UPDATE_WHITEBOARD_HOST : undefined;
};
function waitingForHost(s: Session) {
    return s.store.replica.pending.some(({ action }) =>
        (s.whiteboard === false && insertsWhiteboard(action.ops)) ||
        (s.extendedBlobPaths === false && usesExtendedBlobPaths(action.ops)))
        ? 'Edits are waiting for the Cloud host to update Canvas.' : undefined;
}
export function fileInfo(file: string, open = true) { const s = open ? fileSession(file) : sessions.get(docFile(file)); return s ? { author: s.store.meta.author, name: s.store.meta.name, cloud: s.store.meta.cloud, key: cloudKey(s.store.meta.cloud), file: s.store.meta.file, role: s.store.meta.role, status: s.status, whiteboard: s.whiteboard === true, voting: s.voting, serverTime: voteServerTime(s.voteClock), leasedConclusions: s.leasedConclusions, updateMessage: s.updateMessage, assetNotice: s.assetNotice, waitingForHost: waitingForHost(s), pending: s.store.replica.pending.length, refused: s.store.replica.refused.map(r => ({ id: r.action.id, code: r.code, message: r.message })) } : null; }
class CloudHttpError extends Error {
    readonly status: number;
    readonly code: string;
    constructor(status: number, code: string, message: string) {
        super(message);
        this.status = status;
        this.code = code;
    }
}
const checkGeneration = (cloud: string, g: number) => {
    if (generation(cloud) !== g || !isConfigured(cloud))
        fail(409, 'cloud_changed', 'Cloud sign-in or configuration changed');
};
async function request(cloud: string, p: string, method = 'GET', body?: unknown): Promise<Response> {
    cloud = resolveCloud(cloud);
    if(revoked.has(cloud))fail(403,'removed','Cloud membership was removed');
    const g = generation(cloud), t = await target(cloud);
    checkGeneration(cloud, g);
    if ('fail' in t) {
        if (t.fail === 'removed') removeCaches(cloud);
        fail(503, t.fail, 'The Cloud is unavailable');
    }
    const r = await fetch((t as any).base + p, { method, headers: { ...(t as any).headers, [FILE_CAPABILITIES_HEADER]: [WHITEBOARD, ...VOTE_CLIENT_CAPABILITIES].join(', '), ...(body === undefined ? {} : { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' }) }, body: body === undefined ? undefined : body instanceof Uint8Array ? body as BodyInit : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
    checkGeneration(cloud, g);
    if (r.status === 403) {
        void r.body?.cancel().catch(() => {});
        throw new CloudHttpError(403, 'forbidden', 'Access to this Cloud was refused');
    }
    if (!r.ok) {
        const j = await cloudJson(r).catch(() => ({})) as any;
        checkGeneration(cloud, g);
        // A Mac host refuses a removed device's bearer with 401 unauthenticated.
        if (r.status === 401 && (hostedId(cloud) || j.code === 'removed')) removeCaches(cloud);
        throw new CloudHttpError(r.status, j.code ?? 'cloud', j.message ?? 'The Cloud refused the request');
    }
    return r;
}
export async function cloudMembers(cloud: string): Promise<unknown[]> {
    try { const data = await cloudJson(await request(cloud, '/v1/members')); return Array.isArray(data) ? data : []; } catch { return []; }
}
export const cloudFiles = async (cloud: string, query = '') => cloudJson(await request(cloud, '/v1/files?q=' + encodeURIComponent(query)));
function objects(cloud: string, file: string): ObjectStore {
    return {
        async get(key) { const m = /^files\/([^/]+)\/(boards|vers)\/([0-9a-f]{64})\.json\.gz$/.exec(key); if (!m || m[1] !== file || !SHA.test(m[3]))
            throw new Error('Invalid snapshot object'); return boundedBytes(await request(cloud, `/v1/files/${file}/${m[2]}/${m[3]}`), 34 * 1024 * 1024); },
        async putIfAbsent() { throw new Error('Read only objects'); }, async delete() { throw new Error('Read only objects'); }, async list() { return []; },
    };
}
async function cacheBlobs(s: Session) {
    const { cloud, file } = s.store.meta;
    const g = generation(cloud);
    s.assetNotice = await downloadBlobs(cloud, file, s.store.pkg, s.store.replica.tree.state().blobs, () => s.stopped || generation(cloud) !== g);
}
function blobDestination(pkg: string, rel: string, makeParents = false) {
    if (checkBlobPath(rel)) throw new Error('Invalid blob path');
    const parts = rel.split('/');
    let dir = pkg;
    for (const part of ['', ...parts.slice(0, -1)]) {
        if (part) dir = path.join(dir, part);
        const stat = fs.lstatSync(dir, { throwIfNoEntry: false });
        if (stat && !stat.isDirectory()) throw new Error('Cloud cache folder is a link or a file');
        if (!stat && makeParents) fs.mkdirSync(dir, { mode: 0o700 });
    }
    const dest = path.join(dir, parts.at(-1)!);
    const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new Error('Cloud cache asset is a link or a folder');
    return dest;
}

function saveCacheAsset(dest: string, bytes: Uint8Array) {
    const parent = path.dirname(dest), name = path.basename(dest);
    const before = fs.lstatSync(parent);
    if (!before.isDirectory() || fs.realpathSync(parent) !== parent) throw new Error('Cloud cache asset folder changed');
    const cwd = process.cwd();
    // Node has no renameat. Use relative names inside the verified directory for this synchronous write.
    process.chdir(parent);
    try {
        const current = fs.statSync('.');
        if (before.dev !== current.dev || before.ino !== current.ino) throw new Error('Cloud cache asset folder changed');
        const tmp = '.asset-' + randomUUID();
        const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
            | (process.platform === 'darwin' ? O_NOFOLLOW_ANY : fs.constants.O_NOFOLLOW);
        const fd = fs.openSync(tmp, flags, 0o600);
        try {
            fs.writeFileSync(fd, bytes);
            const existing = fs.lstatSync(name, { throwIfNoEntry: false });
            if (existing && (!existing.isFile() || existing.nlink !== 1)) throw new Error('Cloud cache asset is a link or a folder');
            fs.renameSync(tmp, name);
        } finally {
            fs.closeSync(fd);
            fs.rmSync(tmp, { force: true });
        }
    } finally { process.chdir(cwd); }
}

export async function downloadBlobs(cloud: string, file: string, pkg: string, blobs: Record<string, BlobRow>, cancelled: () => boolean) {
    const missing = new Map<string, { blob: BlobRow; paths: string[] }>();
    let skipped = 0;
    for (const [rel, blob] of Object.entries(blobs)) {
        if (checkBlobPath(rel)) {
            if (!safeBlobPath(rel)) throw new Error('Invalid blob path');
            skipped++;
            continue;
        }
        const dest = blobDestination(pkg, rel);
        if (fs.existsSync(dest)) {
            const opened = openInPackage(pkg, rel, fs);
            if ('refused' in opened) throw new Error(opened.refused);
            try {
                if (createHash('sha256').update(fs.readFileSync(opened.fd)).digest('hex') === blob.sha256) continue;
            } finally { fs.closeSync(opened.fd); }
        }
        if (blob.bytes > 100 * 1024 * 1024) throw new Error('Blob exceeds limit');
        const group = missing.get(blob.sha256);
        if (group) group.paths.push(rel);
        else missing.set(blob.sha256, { blob, paths: [rel] });
    }
    const save = ({ blob, paths }: { blob: BlobRow; paths: string[] }, bytes: Uint8Array) => {
        if (createHash('sha256').update(bytes).digest('hex') !== blob.sha256 || bytes.length !== blob.bytes)
            throw new Error('Blob hash mismatch');
        if (cancelled() || revoked.has(cloud)) throw new Error('Cloud membership was removed during download');
        for (const rel of paths) saveCacheAsset(blobDestination(pkg, rel, true), bytes);
    };
    const route = `/v1/files/${file}`;
    let bulk = true;
    for (const batch of blobBatches(missing.values(), entry => entry.blob.bytes)) {
        if (bulk) {
            let response: Response | undefined;
            try { response = await request(cloud, route + '/blob-batch', 'POST', { hashes: batch.map(e => e.blob.sha256) }); }
            catch (error) {
                if (!(error instanceof CloudHttpError) || ![404, 405].includes(error.status)) throw error;
                bulk = false; // Older hosts only serve one blob per request.
            }
            if (response) {
                const total = batch.reduce((sum, e) => sum + e.blob.bytes, 0);
                const bytes = await boundedBytes(response, total);
                if (bytes.length !== total) throw new Error('Incomplete Cloud blob batch');
                let offset = 0;
                for (const entry of batch) {
                    save(entry, bytes.subarray(offset, offset + entry.blob.bytes));
                    offset += entry.blob.bytes;
                }
                continue;
            }
        }
        for (const entry of batch) save(entry, await boundedBytes(await request(cloud, route + '/blobs/' + entry.blob.sha256), entry.blob.bytes));
    }
    if (skipped) return `Skipped ${skipped} unsupported asset${skipped === 1 ? '' : 's'}. Update Canvas to see the complete file.`;
}
function render(s: Session) { if (s.stopped)
    return; adoptWriters(path.join(s.store.pkg, 'document.json'), s.store.replica.view().allVers()); s.store.materialize(); fileEvents.view?.(path.join(s.store.pkg, 'document.json')); }
function commentState(s: Session): CommentsFile {
    return { format: 1, doc: s.store.meta.file, seq: s.commentsSeq, threads: s.comments, outbox: s.commentsPending,
        rejected: s.commentsRejected ?? [], cloudVotes: s.cloudVotes, cloudTimer: s.cloudTimer, timerCapable: s.timerCapable, voteConclusions: s.voteConclusions };
}
export function fileVoteState(file: string): CommentsFile | undefined {
    const s = sessions.get(docFile(file));
    return s && { ...commentState(s), votes: s.legacyVotes };
}
export function clearLegacyFileVote(file: string, vote: string) {
    const s = sessions.get(docFile(file));
    if (!s?.legacyVotes?.some(v => v.id === vote)) return false;
    s.legacyVotes = s.legacyVotes.filter(v => v.id !== vote);
    s.legacyVoteConclusions = s.legacyVoteConclusions?.filter(id => id !== vote);
    saveComments(s);
    return true;
}
function saveVoteViews(s: Session, votes: VoteView[]) {
    const state = commentState(s);
    receiveVoteViews(state, votes, state.outbox, s.leasedConclusions);
    s.cloudVotes = state.cloudVotes;
    s.voteConclusions = state.voteConclusions;
}
export function hasConfirmedFileLayer(file: string, layer: string) {
    return !!sessions.get(docFile(file))?.store.replica.tree.node(layer);
}
export function completeFileVoteConclusion(file: string, vote: string) {
    const s = sessions.get(docFile(file));
    if (!s) return;
    s.voteConclusions = s.voteConclusions?.filter(id => id !== vote);
    s.cloudVotes = s.cloudVotes?.filter(v => v.state !== 'dismissed' || v.id !== vote);
    saveComments(s);
}
export function queueFileVote(file: string, envelope: OpEnvelope) {
    const s = sessions.get(docFile(file));
    if (!s) return fail(409, "conflict", "Open the Cloud file before voting.");
    if (!s.voting) fail(426, 'version', s.voting === false ? UPDATE_VOTE_HOST : 'Connect to the Cloud to check for voting support.');
    if (needsCloudTimers(envelope.op) && !s.timerCapable) fail(426, 'version', UPDATE_TIMER_HOST);
    if (!s.commentsPending.some(e => e.opId === envelope.opId) && !s.commentsRejected?.some(r => r.envelope.opId === envelope.opId)) {
        s.commentsPending.push({ ...envelope, doc: s.store.meta.file });
        saveComments(s);
        sendComments(s);
    }
}
function saveComments(s: Session) {
    s.store.db.prepare('INSERT OR REPLACE INTO comments_state VALUES(1,?)').run(JSON.stringify({ comments: s.comments, commentsSeq: s.commentsSeq, commentsPending: s.commentsPending, commentsRejected: s.commentsRejected ?? [], voting: s.voting, cloudVotes: s.cloudVotes, cloudTimer: s.cloudTimer, timerCapable: s.timerCapable, voteConclusions: s.voteConclusions, legacyVotes: s.legacyVotes, legacyVoteConclusions: s.legacyVoteConclusions, voteQueueVersion: 1 }));
    const threads = structuredClone(s.comments);
    for (const e of [...s.commentsPending, ...(s.commentsRejected ?? []).map(r => r.envelope)])
        if (!isVoteOp(e.op)) applyOp(threads, s.store.meta.file, e.op, { name: s.store.meta.author.name ?? "Me", id: s.store.meta.author.id }, e.at);
    writeCommentsFile(s.store.pkg, { ...readCommentsFile(s.store.pkg), ...commentState(s), threads });
}

function waitForQuota(s: Session) {
    s.status = 'quota'; s.commentsInFlight?.clear(); for (const p of s.store.replica.pending) p.sent = false; s.store.commit();
    if (s.timer) clearTimeout(s.timer);
    s.timer = setTimeout(() => { if (!s.stopped) { s.status = 'connected'; void send(s).catch(() => s.ws?.close()); } }, 60_000); s.timer.unref();
}
function recoverDrafts(s: Session) {
    if (!s.recovery) {
        const local = path.join(os.homedir(), 'Documents', 'Canvas Recovered', s.store.meta.file + '-' + randomUUID() + '.canvas');
        s.store.materialize(); fs.mkdirSync(path.dirname(local), { recursive: true });
        fs.cpSync(s.store.pkg, local, { recursive: true, filter: p => !['.cloud', COMMENTS_FILE].includes(path.basename(p)) });
        // Legacy builds could leave votes local to the cache. Keep this Mac's ballots if that's the only copy.
        try {
            forkComments(s.store.pkg, local);
            if (s.legacyVotes?.length) {
                const copy = readCommentsFile(local)!;
                copy.votes = ownLocalVotes(s.legacyVotes);
                copy.voteConclusions = s.legacyVoteConclusions;
                writeCommentsFile(local, copy);
            }
        } catch { /* The design and outbox can still be recovered if the sidecar is unreadable. */ }
        const drafts = new Map([...s.store.replica.refused, ...s.store.replica.pending].flatMap(p => (p.textDrafts ?? []).map(d => [d.id, d.content] as const)));
        if (drafts.size) {
            const file = path.join(local, 'document.json'), doc = JSON.parse(fs.readFileSync(file, 'utf8'));
            const walk = (nodes: any[]) => { for (const n of nodes) { if (drafts.has(n.id)) n.content = drafts.get(n.id); if (Array.isArray(n.children)) walk(n.children); } };
            walk(doc.children ?? []); fs.writeFileSync(file, JSON.stringify(doc));
        }
        s.recovery = local;
    }
    const file = path.join(s.recovery, 'unsent-actions.json');
    const previous = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { pending: [], refused: [] };
    const refused = new Map([...previous.refused, ...s.store.replica.refused].map(p => [p.action.id, p]));
    const pending = new Map([...previous.pending, ...s.store.replica.pending].map(p => [p.action.id, p]));
    for (const id of refused.keys()) pending.delete(id);
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ pending: [...pending.values()], refused: [...refused.values()], comments: s.commentsPending.filter(e => !isVoteOp(e.op)), rejectedComments: s.commentsRejected?.filter(r => !isVoteOp(r.envelope.op)) ?? [] }), { mode: 0o600 }); fs.renameSync(tmp, file);
}
export async function receive(s: Session, m: any) {
    if (s.stopped)
        return;
    if (m.type === 'error') s.commentsInFlight?.clear();
    if (m.type === 'presence') {
        s.peers ??= new Map();
        for (const p of m.peers as PeerPresence[]) {
            if (p.gone) s.peers.delete(p.session);
            else s.peers.set(p.session, { ...keep(s.peers.get(p.session) ?? {}, p), session:p.session, by:p.by, role:p.role });
        }
        fileEvents.presence?.(path.join(s.store.pkg, 'document.json'), m.peers);
        return;
    }
    if (m.type === 'error' && m.code === 'update') {
        if (!s.updateMessage) fileEvents.update?.(path.join(s.store.pkg, 'document.json'), m.message);
        s.updateMessage = m.message;
        s.whiteboard = false;
        s.store.replica.joined = false;
        render(s);
        s.ws?.close();
        return;
    }
    if ((m.type==='error'||m.type==='reject')&&m.code==='quota') {
      waitForQuota(s);
      return;
    }
    if (m.type === 'removed') {
        removeCaches(s.store.meta.cloud);
        return;
    }
    if (m.type === 'role') {
        s.store.meta.role = m.role;
        s.store.commit();
        render(s);
        return;
    }
    if ((m.type === 'comments.snapshot' || m.type === 'comments.applied') && m.serverTime) s.voteClock = anchorVoteClock(m.serverTime);
    if (m.type === 'comments.snapshot') {
        if (m.votes) saveVoteViews(s, m.votes);
        if (m.timer !== undefined) s.cloudTimer = m.timer;
        s.comments = m.threads;
        s.commentsSeq = m.seq;
        saveComments(s);
        fileEvents.comments?.(path.join(s.store.pkg, 'document.json'));
        return;
    }
    if (m.type === 'comments.applied') {
        if (m.votes) saveVoteViews(s, m.votes);
        if (m.timer !== undefined) s.cloudTimer = m.timer;
        for (const e of m.entries) {
            if (e.seq <= s.commentsSeq)
                continue;
            if (e.seq !== s.commentsSeq + 1) {
                s.ws?.close();
                return;
            }
            s.commentsInFlight?.delete(e.opId);
            applyOp(s.comments, s.store.meta.file, e.op, e.by, e.at);
            s.commentsSeq = e.seq;
            s.commentsPending = s.commentsPending.filter(p => p.opId !== e.opId);
        }
        saveComments(s);
        fileEvents.comments?.(path.join(s.store.pkg, 'document.json'));
        return;
    }
    if (m.type === 'comments.ack') {
        for (const a of m.acks) s.commentsInFlight?.delete(a.opId);
        const rejected = new Map<string, Rejected>();
        for (const r of (m.rejected ?? []) as Rejected[]) {
            s.commentsInFlight?.delete(r.opId);
            const envelope = s.commentsPending.find(p => p.opId === r.opId);
            if (!envelope) continue;
            if (isRateRefusal(r)) { waitForQuota(s); continue; }
            rejected.set(r.opId, r);
            (s.commentsRejected ??= []).push({ envelope, code: r.code, message: r.message });
        }
        s.commentsPending = s.commentsPending.filter(p => !m.acks.some((a: any) => a.opId === p.opId && a.seq <= s.commentsSeq) && !rejected.has(p.opId));
        sendComments(s);
        saveComments(s);
        fileEvents.comments?.(path.join(s.store.pkg, 'document.json'));
        return;
    }
    if ((m.type === 'reject' && m.code !== 'quota' && s.store.replica.pending.some(p => p.action.id === m.id)) || (m.type === 'reset' && s.store.replica.pending.length)) {
        recoverDrafts(s);
    }
    const result = await s.store.receive(m as FileServerMessage, objects(s.store.meta.cloud, s.store.meta.file));
    if (s.recovery) recoverDrafts(s);
    if(m.type==='applied') for(const a of m.actions) {
        if(!a.by.agent || a.by.id===s.store.meta.author.id)continue;
        const op=a.ops.find((o:FileOp)=>'id' in o || o.k==='insert'), id=op && (op.k==='insert' ? op.node.id : op.id);
        if(!id)continue;
        const tree=s.store.replica.view(), n=tree.node(id); if(!n)continue;
        let x=Number(n.props.x)||0,y=Number(n.props.y)||0;
        for(const parent of tree.ancestors(id,256)) {const p=tree.node(parent);x+=Number(p?.props.x)||0;y+=Number(p?.props.y)||0;}
        fileEvents.presence?.(path.join(s.store.pkg,'document.json'),[{session:'agent:'+a.by.id,by:a.by,role:'editor',cursor:{x,y},sel:[id],editing:{id}}]);
    }
    if(m.type==='applied'&&Number(s.store.db.prepare('SELECT COUNT(*) AS n FROM confirmed').get()!.n)>=2000)checkpointSession(s);
    if (m.type === 'welcome') {
        s.whiteboard = supportsWhiteboard(m.capabilities);
        s.extendedBlobPaths = m.capabilities?.includes(EXTENDED_BLOB_PATHS) === true;
        s.voting = supportsCloudVotes(m.capabilities);
        s.timerCapable = supportsCloudTimers(m.capabilities);
        s.voteClock = anchorVoteClock(m.serverTime);
        s.leasedConclusions = supportsPrivateVoteViews(m.capabilities);
        s.updateMessage = undefined;
        s.status = 'connected';
        s.retryDelay = undefined;
    }
    await cacheBlobs(s);
    render(s);
    if (result === 'hello' || result === 'gap')
        s.ws?.send(JSON.stringify(s.store.replica.hello(s.store.meta.file)));
    else if (m.type === 'welcome' || m.type === 'applied' || m.type === 'ack')
        await send(s);
}
function sendComments(s: Session) {
    if (s.ws?.readyState !== WebSocket.OPEN || !s.store.replica.joined || s.stopped || s.status !== 'connected') return;
    const inFlight = s.commentsInFlight ??= new Set<string>();
    if (inFlight.size) return;
    const ops = sendableCommentOps(s.commentsPending, s.store.meta.role, s.voting, s.timerCapable).slice(0, LIMITS.opsPerMessage);
    if (!ops.length) return;
    for (const e of ops) inFlight.add(e.opId);
    s.ws.send(JSON.stringify({ type: 'comments', ops }));
}
async function send(s: Session) {
    if (s.ws?.readyState !== WebSocket.OPEN || !s.store.replica.joined || s.stopped || s.status==='quota')
        return;
    sendComments(s);
    if (!CAN_EDIT[s.store.meta.role])
        return;
    const actions = s.store.replica.outgoing(100, ({ ops }) =>
        (s.whiteboard === true || !insertsWhiteboard(ops)) && (s.extendedBlobPaths === true || !usesExtendedBlobPaths(ops)));
    s.store.commit();
    for (const a of actions) {
        for (const op of a.ops)
            if (op.k === 'blob') {
                const bytes = fs.readFileSync(path.join(s.store.pkg, op.path));
                if (createHash('sha256').update(bytes).digest('hex') !== op.sha256)
                    throw new Error('Local blob hash mismatch');
                const up = await cloudJson(await request(s.store.meta.cloud, `/v1/files/${s.store.meta.file}/uploads`, 'POST', op)) as any;
                await request(s.store.meta.cloud, `/v1/files/${s.store.meta.file}/uploads/${up.id}`, 'PUT', bytes);
            }
        s.ws.send(JSON.stringify({ type: 'actions', epoch: s.store.replica.epoch, actions: [a] }));
    }
}
function reconnect(s: Session) {
    if (s.stopped || s.offline) return;
    s.status = 'offline';
    clearTimeout(s.timer);
    const delay = s.retryDelay ?? 500;
    s.retryDelay = Math.min(delay * 2, 30_000);
    s.timer = setTimeout(() => void connect(s), delay);
    s.timer.unref();
}
function closeSession(file: string, s: Session, missing = false) {
    const replica = s.store.replica;
    let local;
    try { local = readCommentsFile(s.store.pkg); } catch { /* the sidecar is unreadable */ }
    if (replica.pending.length || replica.refused.length || s.commentsPending.length || s.commentsRejected?.length || s.legacyVotes?.length || local?.votes?.length) {
        recoverDrafts(s);
        if (missing) {
            replica.pending = [];
            replica.refused = [];
            s.commentsPending = [];
            s.commentsRejected = [];
            s.store.commit();
            saveComments(s);
        }
    }
    s.stopped = true;
    clearPresence(s);
    if (s.timer) clearTimeout(s.timer);
    s.ws?.close();
    s.store.close();
    sessions.delete(file);
    fileEvents.removed?.(file);
}
async function connect(s: Session): Promise<'missing' | void> {
    if (s.stopped || s.offline || s.connecting || s.ws)
        return;
    if (s.timer) clearTimeout(s.timer);
    s.connecting = true;
    const { cloud, file, name } = s.store.meta;
    const doc = path.join(s.store.pkg, 'document.json');
    const g = generation(cloud);
    try {
        // The list predates the per-file route and reports the same Cloud role used for socket authentication.
        const listed = await cloudFiles(cloud) as { files?: { id: string; name: string }[]; role?: Role };
        if (s.stopped || s.offline)
            return;
        if (!Array.isArray(listed.files))
            throw new Error('Invalid Cloud file list');
        const role = listed.role ?? (await cloudJson(await request(cloud, '/v1/me')) as { role: Role }).role;
        if (s.stopped || s.offline)
            return;
        checkGeneration(cloud, g);
        const remote = listed.files.find(item => item.id === file);
        // During a move the new file is private to its importer until import/complete.
        if (remote) s.importing = false;
        else if (!s.importing) {
            closeSession(doc, s, true);
            return 'missing';
        }
        if (!Object.hasOwn(CAN_EDIT, role))
            throw new Error('Invalid Cloud role');
        const nextName = remote?.name && s.store.meta.name === name ? remote.name : s.store.meta.name;
        if (nextName !== s.store.meta.name || role !== s.store.meta.role) {
            s.store.meta.name = nextName;
            s.store.meta.role = role;
            s.store.commit();
            fileEvents.view?.(doc);
        }
        const t = await target(cloud);
        checkGeneration(cloud, g);
        if ('fail' in t) {
            if (t.fail === 'removed') removeCaches(cloud);
            throw new Error(t.fail);
        }
        if (s.stopped || s.offline)
            return;
        const ws = new WebSocket(t.base.replace(/^http/, 'ws') + `/v1/files/${s.store.meta.file}/socket`, { headers: t.headers } as unknown as string[]);
        s.ws = ws;
        ws.addEventListener('open', () => {
            if (s.stopped || generation(cloud) !== g) { ws.close(); return; }
            ws.send(JSON.stringify(s.store.replica.hello(file)));
        });
        ws.addEventListener('message', e => {
            s.chain = s.chain.then(() => asOneAction(doc, () => {
                if (generation(cloud) !== g) { ws.close(); return; }
                return receive(s, JSON.parse(String(e.data)));
            })).catch(() => {
                if (!s.stopped) {
                    s.status = 'offline';
                    ws.close();
                }
            });
        });
        ws.addEventListener('close', () => {
            if (s.ws !== ws) return;
            clearPresence(s);
            s.commentsInFlight?.clear();
            s.ws = undefined;
            reconnect(s);
        });
        ws.addEventListener('error', () => ws.close());
    }
    catch (e) {
        if (!s.stopped && generation(cloud) === g && e instanceof CloudHttpError && e.status === 403)
            removeCaches(cloud);
        else
            reconnect(s);
    } finally {
        s.connecting = false;
    }
}
onAction((file, action) => { const s = fileSession(file); if (!s)
    return;
    let a; try {
    requireStationaryFile(file);
    if (s.updateMessage) fail(426, 'update', s.updateMessage);
    if (s.whiteboard !== true && insertsWhiteboard(action.ops)) fail(426, 'update_host', UPDATE_WHITEBOARD_HOST);
    if (s.extendedBlobPaths !== true && usesExtendedBlobPaths(action.ops)) fail(426, 'update_host', UPDATE_BLOB_PATHS_HOST);
    a = s.store.propose(action.ops, action);
}
catch (e) {
    render(s);
    throw e;
} if ('reject' in a) {
    render(s);
    fail(a.reject === 'forbidden' ? 403 : 409, a.reject, a.message);
} render(s); s.chain = s.chain.then(() => send(s)).catch(() => { s.ws?.close(); }); }, true);
export async function openCloudFile(cloud: string, id: string, importingName?: string) {
    cloud = resolveCloud(cloud); const openingGeneration=generation(cloud);
    if (!UUID.test(id))
        fail(400, 'invalid', 'Invalid file id');
    if (revoked.has(cloud))
        fail(403, 'removed', 'Cloud membership was removed');
    const pkg = path.join(root(), cloudKey(cloud), id + '.canvas');
    const staged = importingName !== undefined;
    const cached = fileSession(pkg, staged, staged);
    if (cached) {
        // Give a reachable host time to confirm a cold cached replica while still allowing offline opens.
        if (cached.initialConnect) {
            let timer: NodeJS.Timeout | undefined;
            try {
                const result = await Promise.race([cached.initialConnect, new Promise<void>(resolve => {
                    timer = setTimeout(resolve, 750);
                })]);
                if (result === 'missing') fail(404, 'not_found', 'No such Cloud file');
            } finally { clearTimeout(timer); }
        }
        if (cached.stopped) fail(403, 'removed', 'Cloud membership was removed during open');
        if (cached.updateMessage) fail(426, 'update', cached.updateMessage);
        return { id, file: pkg, name: cached.store.meta.name, cloud, role: cached.store.meta.role, notice: cached.assetNotice };
    }
    const listed = importingName === undefined ? await cloudFiles(cloud) as any : null;
    const item = importingName === undefined ? listed.files?.find((f: any) => f.id === id) : {id,name:importingName};
    if (!item)
        fail(404, 'not_found', 'No such Cloud file');
    let s = sessions.get(path.join(pkg, 'document.json'));
    if (!s && fs.existsSync(path.join(pkg, '.cloud', 'state.sqlite')))
        s = fileSession(pkg, staged, staged);
    if (!s) {
        const me = await cloudJson(await request(cloud, '/v1/me')) as any;
        const m = await cloudJson(await request(cloud, `/v1/files/${id}/manifest`)) as Manifest;
        if (m.file !== id)
            throw new Error('Manifest names another file');
        const { state } = await loadManifest(objects(cloud, id), JSON.stringify(m), true);
        checkGeneration(cloud, openingGeneration);
        const store = new FileStateStore(pkg, { cloud, file: id, name: item.name, role: me.role, author: { id: me.id, name: me.name }, state });
        store.replica.seq = m.seq;
        store.replica.epoch = m.epoch;
        store.commit();
        store.materialize();
        store.close();
        s = fileSession(pkg, staged, staged)!;
        await cacheBlobs(s);
    }
    if (importingName === undefined && s.store.meta.name !== item.name) {
        s.store.meta.name = item.name;
        s.store.commit();
    }
    evictClosedPackages(root(),new Set([...sessions.values()].map(s=>s.store.pkg)));
    return { id, file: pkg, name: item.name, cloud, role: s.store.meta.role, notice: s.assetNotice };
}
function* importBatches<T>(items: T[], count: number, byteLimit = 1024 * 1024 - 100): Generator<T[]> {
    let batch: T[] = [], size = 2;
    for (const item of items) {
        const bytes = Buffer.byteLength(JSON.stringify(item)) + 1;
        if (bytes + 2 > byteLimit) throw new Error('One item exceeds the Cloud import size limit');
        if (batch.length && (size + bytes > byteLimit || batch.length === count)) {
            yield batch;
            batch = [];
            size = 2;
        }
        batch.push(item);
        size += bytes;
    }
    if (batch.length) yield batch;
}

const IMPORT_BATCH_PAYLOAD = TRANSFER_PART_BYTES - TRANSFER_HEADER_BYTES - 4;
async function uploadMoveBlobs(cloud: string, route: string, blobs: MoveBlob[]) {
    const unique = new Map(blobs.map(blob => [blob.op.sha256, blob]));
    for (const batch of blobBatches(unique.values(), item => item.bytes.length, IMPORT_BATCH_PAYLOAD)) {
        if (batch[0].bytes.length > IMPORT_BATCH_PAYLOAD) {
            const { op, bytes } = batch[0];
            const { id } = await cloudJson(await request(cloud, route + '/uploads', 'POST', op));
            const upload = `${route}/uploads/${id}`;
            for (let offset = 0, part = 0; offset < bytes.length; offset += TRANSFER_PART_BYTES, part++)
                await request(cloud, `${upload}/parts/${part}`, 'PUT', bytes.subarray(offset, offset + TRANSFER_PART_BYTES));
            await request(cloud, upload + '/complete', 'POST', {});
        } else {
            const header = Buffer.from(JSON.stringify(batch.map(item => item.op)));
            const prefix = Buffer.alloc(4);
            prefix.writeUInt32BE(header.length);
            await request(cloud, route + '/blobs', 'PUT', Buffer.concat([prefix, header, ...batch.map(item => item.bytes)]));
        }
    }
}

async function commitTransfer(cloud: string, route: string, method: string, body: unknown) {
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            await request(cloud, route, method, body);
            return;
        } catch (error) {
            const refusal = error instanceof CloudHttpError && error.status < 500;
            if (!attempt && refusal) throw error;
            if (attempt) {
                if (refusal && error.code === 'file_changed') throw error;
                throw new MovePendingError('The Cloud did not confirm the move');
            }
        }
    }
}

function requireSyncedMoveSource(pkg: string) {
    const s = fileSession(pkg);
    if (s && (s.store.replica.pending.length || s.store.replica.refused.length || s.commentsPending.length || s.commentsRejected?.length)) {
        fail(409, 'unsynced', 'This Cloud file has edits that have not synced');
    }
}

async function downloadCloudFile(cloud: string, id: string, target: unknown, move: boolean) {
    cloud = resolveCloud(cloud);
    const targetFile = targetPath(target);
    const g = generation(cloud);
    const cancelled = () => generation(cloud) !== g;
    const route = `/v1/files/${id}`;
    const pkg = path.join(root(), cloudKey(cloud), id + '.canvas');
    const source = docFile(pkg);
    let comments: { seq: number; threads: Thread[] } | undefined;
    if (move) {
        requireStationaryFile(source);
        let response: Response;
        try { response = await request(cloud, route + '/move'); }
        catch (error) {
            if (!(error instanceof CloudHttpError) || error.status !== 404) throw error;
            await request(cloud, route);
            return fail(426, 'update_move_host', 'Update Canvas on the host to move files to Local Files');
        }
        comments = await cloudJson(response);
        if (!comments || !Number.isSafeInteger(comments.seq) || !Array.isArray(comments.threads)) {
            fail(400, 'invalid', 'The Cloud did not return comments for this file');
        }
        requireSyncedMoveSource(pkg);
    }
    const manifest = await cloudJson(await request(cloud, route + '/manifest')) as Manifest;
    if (manifest.file !== id) throw new Error('Manifest names another file');
    const { state } = await loadManifest(objects(cloud, id), JSON.stringify(manifest), true);
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'canvas-cloud-download-'));
    let stage: string | undefined;
    let keepStage = false;
    try {
        const notice = await downloadBlobs(cloud, id, dir, state.blobs, cancelled);
        if (move && notice) fail(426, 'update', notice);
        await request(cloud, route);
        if (cancelled()) fail(403, 'removed', 'Cloud membership was removed during download');
        if (move) {
            requireStationaryFile(source);
            requireSyncedMoveSource(pkg);
        }
        const tree = DocTree.fromState(state);
        const localComments = comments?.threads.length ? emptyComments() : undefined;
        if (localComments && comments) localComments.threads = comments.threads.map(thread => ({ ...thread, doc: localComments.doc }));
        if (move) {
            if (fs.lstatSync(targetFile, { throwIfNoEntry: false })) fail(409, 'conflict', 'The local destination already exists');
            stage = stageMove(targetFile);
        }
        const file = createPackage(stage ? path.join(stage, path.basename(targetFile)) : targetFile, tmp => {
            const files = [['document.json', documentOf(tree)], ['widgets.json', envelopeOf(tree)]] as [string, unknown][];
            if (localComments) files.push([COMMENTS_FILE, localComments]);
            for (const [name, json] of files) {
                const dest = path.join(tmp, name), bytes = JSON.stringify(json);
                fs.writeFileSync(dest, bytes);
                if (move && fs.readFileSync(dest, 'utf8') !== bytes) throw new Error(`Move verification failed: ${name} differs`);
            }
            for (const [rel, blob] of Object.entries(state.blobs)) {
                if (checkBlobPath(rel)) continue;
                const dest = path.join(tmp, rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(path.join(dir, rel), dest, fs.constants.COPYFILE_FICLONE);
                if (move && createHash('sha256').update(fs.readFileSync(dest)).digest('hex') !== blob.sha256)
                    throw new Error('Move verification failed: blob hash differs');
            }
        });
        if (!move) return { file, notice };
        const makeLocalVisible = () => {
            keepStage = true;
            const visible = restoreMovedPackage(file);
            keepStage = false;
            return visible;
        };
        committingMoves.add(source);
        try {
            await commitTransfer(cloud, `${route}/move`, 'DELETE', { seq: manifest.seq, epoch: manifest.epoch, commentsSeq: comments?.seq, token: randomUUID() });
        } catch (error) {
            if (error instanceof MovePendingError) {
                let visible = file;
                try { visible = makeLocalVisible(); } catch { /* Leave the package for startup recovery. */ }
                throw new MovePendingError(`${error.message}. The verified local copy is at ${visible}`);
            }
            throw error;
        } finally {
            committingMoves.delete(source);
        }
        let visible: string;
        try { visible = makeLocalVisible(); }
        catch {
            throw new MovePendingError(`The Cloud move completed; the verified local copy is at ${file}`);
        }
        const session = sessions.get(source);
        if (session) {
            try { closeSession(source, session, true); }
            catch (error) { fileEvents.problem?.((error as Error).message); }
        }
        return { file: fs.realpathSync(visible), verified: true, moved: true };
    } finally {
        if (stage) {
            try { if (!keepStage) fs.rmSync(stage, { recursive: true, force: true }); }
            finally { finishMoveStage(stage); }
        }
        fs.rmSync(dir, { recursive: true, force: true });
    }
}
async function renameCloudFileById(cloud: string, id: string, name: unknown) {
    const renamed = await cloudJson(await request(cloud, `/v1/files/${id}`, 'PATCH', { name })) as { name?: string };
    const savedName = renamed.name ?? String(name);
    for (const s of sessions.values()) {
        if (s.store.meta.cloud !== cloud || s.store.meta.file !== id) continue;
        s.store.meta.name = savedName;
        s.store.commit();
        render(s);
    }
    return savedName;
}
export async function renameCloudFile(file: string, name: unknown) {
    const s = fileSession(file);
    if (!s) return fail(404, 'not_found', 'No such Cloud file');
    await renameCloudFileById(s.store.meta.cloud, s.store.meta.file, name);
    return s.store.pkg;
}
export async function createCloudFile(cloud: string, name: string) {
    cloud = resolveCloud(cloud);
    const info = await cloudJson(await request(cloud, '/v1/info')) as any;
    if (!info.capabilities?.includes('files'))
        fail(426, 'update', 'Update Canvas');
    const id = randomUUID();
    await request(cloud, '/v1/files', 'POST', { id, name });
    return openCloudFile(cloud, id);
}
function removeCaches(cloud: string) {
    revoked.add(cloud); bump(cloud);
    const dir = path.join(root(), cloudKey(cloud));
    if (fs.existsSync(dir))
        for (const name of fs.readdirSync(dir)) {
            if (!/^[0-9a-f-]{36}\.canvas$/.test(name))
                continue;
            const pkg = path.join(dir, name), file = path.join(pkg, 'document.json');
            if (sessions.has(file) || !fs.existsSync(path.join(pkg, '.cloud', 'state.sqlite')))
                continue;
            const store = new FileStateStore(pkg);
            let commentsPending: OpEnvelope[] = [];
            let commentsRejected: RefusedOp[] = [];
            let legacyVotes: Vote[] | undefined, legacyVoteConclusions: string[] | undefined;
            try {
                const c = store.db.prepare('SELECT json FROM comments_state WHERE id=1').get();
                if (c) {
                    const saved = JSON.parse(String(c.json));
                    commentsPending = (saved.commentsPending ?? []).filter((e: OpEnvelope) => !isVoteOp(e.op));
                    commentsRejected = (saved.commentsRejected ?? []).filter((r: RefusedOp) => !isVoteOp(r.envelope.op));
                    legacyVotes = saved.legacyVotes; legacyVoteConclusions = saved.legacyVoteConclusions;
                }
                const old = readCommentsFile(pkg);
                legacyVotes ??= old?.votes;
                legacyVoteConclusions ??= old?.voteConclusions?.filter(id => legacyVotes?.some(v => v.id === id));
            }
            catch { }
            sessions.set(file, { store, status: 'removed', chain: Promise.resolve(), stopped: false, offline: true, comments: [], commentsSeq: 0, commentsPending, commentsRejected, legacyVotes, legacyVoteConclusions });
        }
    for (const [file, s] of sessions) {
        if (s.store.meta.cloud !== cloud)
            continue;
        closeSession(file, s);
    }
    fs.rmSync(path.join(root(), cloudKey(cloud)), { recursive: true, force: true });
    fs.rmSync(path.join(os.homedir(), 'Library', 'Caches', 'Canvas', 'cloud', cloudKey(cloud)), { recursive: true, force: true });
}
onCloudsChanged((removed,back) => { for (const cloud of removed) removeCaches(cloud);for(const cloud of back)revoked.delete(cloud); });
export async function handleCloudFiles(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<boolean> {
    const p = url.pathname;
    if (p === '/api/comments/read') return false;
    if (!p.startsWith('/api/cloud/files') && p !== '/api/cloud/usage' && !(p.startsWith('/api/comments') && url.searchParams.get('file') && fileSession(url.searchParams.get('file')!)))
        return false;
    const out = (status: number, j: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(j)); return true; };
    try {
        if (req.method === 'GET') {
            if (p === '/api/cloud/files/clouds')
                return out(200, { untrusted: true, author: 'Cloud members', clouds: cloudConfigs().map(c => ({ cloud: cloudKey(c.url), url: c.url })) });
            if (p === '/api/cloud/files/info')
                return out(200, fileInfo(url.searchParams.get('file')!));
            if (p === '/api/cloud/usage')
                return out(200, await cloudJson(await request(url.searchParams.get('cloud')!, '/v1/usage')));
            if (p === '/api/cloud/files')
                return out(200, { ...await cloudFiles(url.searchParams.get('cloud')!, url.searchParams.get('query') ?? '') as object, key: cloudKey(resolveCloud(url.searchParams.get('cloud')!)) });
            if (p === '/api/comments') {
                const s = fileSession(url.searchParams.get('file')!)!;
                const people = await cloudMembers(s.store.meta.cloud);
                const { file: doc, author } = s.store.meta;
                const { threads } = JSON.parse(fs.readFileSync(path.join(s.store.pkg, 'comments.json'), 'utf8'));
                const unread = unreadThreads(doc, author, threads);
                return out(200, { me: author.name, people, doc, threads, unread, sync: { me: author, status: s.status, role: s.store.meta.role, canComment: s.store.meta.role !== 'viewer' || s.voting === true, url:s.store.meta.cloud, connected:s.status==='connected', ...pendingStates(commentState(s), s.comments) } });
            }
            return out(404, { error: 'No such route' });
        }
        if (req.headers['x-canvas'] !== '1')
            return out(403, { code: 'forbidden' });
        const raw = await readBodyText(req, 1024 * 1024);
        if (raw === null)
            return out(413, { code: 'quota' });
        const b = JSON.parse(raw || '{}');
        if (p === '/api/cloud/files/create')
            return out(201, await createCloudFile(b.cloud, b.name));
        if (p === '/api/cloud/files/open')
            return out(200, await openCloudFile(b.cloud, b.id));
        if (['duplicate', 'rename', 'delete', 'download'].some(action => p === '/api/cloud/files/' + action)) {
            if (req.method !== 'POST') return out(405, { code: 'invalid' });
            if (typeof b.id !== 'string' || !UUID.test(b.id)) fail(400, 'invalid', 'Invalid file id');
            const cloud = resolveCloud(b.cloud), id = b.id;
            const route = `/v1/files/${id}`;
            if (p.endsWith('/download')) {
                const result = await downloadCloudFile(cloud, id, b.target, b.move === true);
                return out(200, result);
            }
            if (p.endsWith('/duplicate')) return out(201, await cloudJson(await request(cloud, route + '/duplicate', 'POST', {})));
            if (p.endsWith('/delete')) return out(200, await cloudJson(await request(cloud, route, 'DELETE', {})));
            const name = await renameCloudFileById(cloud, id, b.name);
            return out(200, { ok: true, name });
        }
        if (p === '/api/cloud/files/move') {
            if (fileInfo(url.searchParams.get('file')!))
                return out(409, { code: 'conflict', error: 'This file already belongs to a Cloud' });
            const cloud = resolveCloud(b.cloud);
            const info = await cloudJson(await request(cloud, '/v1/info')) as { capabilities?: string[] };
            if (!info.capabilities?.includes(FILE_TRANSFER)) fail(426, 'update_move_host', 'Update Canvas on the host to move files');
            const requestedFile = url.searchParams.get('file')!;
            const source = docFile(movePackagePath(requestedFile));
            if (movingSources.has(source)) fail(409, 'moving', 'This file is being moved');
            movingSources.add(source);
            let importing: string | undefined;
            try {
                const moved = await prepareMove(requestedFile, async (name, doc, env, blobs, comments) => {
                    const voting = supportsCloudVotes(info.capabilities);
                    comments = voteOpsForTransfer(comments, voting && supportsCloudTimers(info.capabilities));
                    if (comments.some(e => isVoteOp(e.op)) && !voting) fail(426, 'version', UPDATE_VOTE_HOST);
                    if (hasWhiteboard(doc.children) && !supportsWhiteboard(info.capabilities)) fail(426, 'update_host', UPDATE_WHITEBOARD_HOST);
                    const id = randomUUID();
                    const route = `/v1/files/${id}/import`;
                    const title = b.name || name;
                    const ops: FileOp[] = [...blobs.map(v => v.op), ...importDocument(doc),
                        ...envelopeFileOps({ widgets: [], extra: {} }, { widgets: env.widgets as Record<string, unknown>[] ?? [],
                            extra: Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'widgets' && k !== 'version')) })];
                    if (!info.capabilities?.includes(EXTENDED_BLOB_PATHS) && usesExtendedBlobPaths(ops))
                        fail(426, 'update_host', UPDATE_BLOB_PATHS_HOST);
                    if (!info.capabilities?.includes(FILE_TRANSFER_PARTS) && blobs.some(blob => blob.bytes.length > IMPORT_BATCH_PAYLOAD))
                        fail(426, 'update_host', 'Update Canvas on the Mac that hosts this Cloud to move large assets.');
                    importing = id;
                    await request(cloud, '/v1/files', 'POST', { id, name: title, importing: true, transfer: true, sourceVisible: true, version: doc.version });
                    await uploadMoveBlobs(cloud, route, blobs);
                    const actions: Action[] = [];
                    let seq = 0;
                    for (const opsPart of importBatches(ops, 100, 1024 * 1024 - 500)) {
                        actions.push({ id: randomUUID(), baseSeq: seq, epoch: 1, ops: opsPart, at: new Date().toISOString() });
                        seq += opsPart.length;
                    }
                    for (const batch of importBatches(actions, 40)) {
                        try { await request(cloud, route + '/actions', 'POST', { actions: batch }); }
                        catch (error) {
                            if (!(error instanceof CloudHttpError) || error.status !== 400) throw error;
                            fail(400, error.code, `Cloud refused import (${error.code}): ${error.message}`);
                        }
                    }
                    let social: { seq: number; threads: Thread[]; votes?: VoteView[]; timer?: StandaloneTimer | null; serverTime?: string } | undefined;
                    for (const ops of importBatches(comments.map(e => ({ ...e, doc: id })), 1000))
                        social = await cloudJson(await request(cloud, route + '/comments', 'POST', { ops }));
                    const opened = await openCloudFile(cloud, id, title);
                    const file = docFile(opened.file), session = sessions.get(file)!;
                    if (session.store.replica.seq !== seq) throw new Error('Move verification failed: import sequence differs');
                    if (social) {
                        const snapshot = social;
                        await asOneAction(file, () => receive(session, { type: 'comments.snapshot', ...snapshot }));
                    }
                    return opened;
                }, async dest => {
                    const session = sessions.get(docFile(dest.file))!;
                    const { seq, epoch } = session.store.replica;
                    committingMoves.add(source);
                    try { await commitTransfer(cloud, `/v1/files/${dest.id}/import/complete`, 'POST', { seq, epoch, commentsSeq: session.commentsSeq }); }
                    finally { committingMoves.delete(source); }
                    session.importing = false;
                    session.initialConnect = connect(session);
                });
                return out(200, moved);
            } catch (error) {
                fileEvents.problem?.((error as Error).message);
                if (importing) {
                    if (!(error instanceof MovePendingError)) {
                        try {
                            await request(cloud, `/v1/files/${importing}/import`, 'DELETE', {});
                        } catch (cleanup) {
                            if (!(cleanup instanceof CloudHttpError) || cleanup.status !== 404)
                                throw new Error(`${(error as Error).message}; local source kept. Cloud cleanup: ${(cleanup as Error).message}`);
                        }
                    }
                    const pkg = path.join(root(), cloudKey(cloud), importing + '.canvas');
                    const file = docFile(pkg), session = sessions.get(file);
                    if (session) closeSession(file, session);
                    fs.rmSync(pkg, { recursive: true, force: true });
                }
                if (error instanceof MovePendingError) throw new MovePendingError(`${error.message}. The local source was kept.`);
                throw error;
            } finally { movingSources.delete(source); }
        }
        const s = fileSession(b.file ?? url.searchParams.get('file') ?? '');
        if (!s)
            return out(404, { code: 'not_found' });
        if(p==='/api/cloud/files/close') {
          await asOneAction(path.join(s.store.pkg,'document.json'),()=>{
            s.stopped=true;clearPresence(s);if(s.timer)clearTimeout(s.timer);s.ws?.close();checkpointSession(s);s.store.materialize();s.store.close();sessions.delete(path.join(s.store.pkg,'document.json'));
          });
          evictClosedPackages(root(),new Set([...sessions.values()].map(s=>s.store.pkg)));return out(200,{ok:true});
        }
        if (p === '/api/cloud/files/presence') return out(200, { ok: sendFilePresence(b.file ?? url.searchParams.get('file')!, b.p) });
        if (p === '/api/cloud/files/disconnect') {
            s.offline = true;
            s.ws?.close();
            s.status = 'offline';
            return out(200, { ok: true });
        }
        if (p === '/api/cloud/files/reconnect') {
            s.offline = false;
            void connect(s);
            return out(200, { ok: true });
        }
        if (p === '/api/comments/retry' || p === '/api/comments/discard') {
            const state = commentState(s);
            (p.endsWith('/retry') ? retry : discard)(state, b.opId);
            s.commentsPending = state.outbox; s.commentsRejected = state.rejected;
            saveComments(s); await send(s);
            return out(200, { ok: true });
        }
        if (p === '/api/comments/ops') {
            requireStationaryFile(s.store.pkg);
            if (s.store.meta.role === 'viewer' && !s.voting)
                return out(426, { code: 'version', error: s.voting === false ? UPDATE_COMMENT_HOST : 'Connect to the Cloud to check for viewer comments.' });
            const ops = (b.ops ?? []).map((e: OpEnvelope) => ({ ...e, doc: s.store.meta.file }));
            if (ops.some((e: OpEnvelope) => e.op && isVoteOp(e.op)))
                return out(400, { code: 'invalid', error: 'Use the vote controls to vote' });
            s.commentsPending.push(...ops);
            saveComments(s);
            sendComments(s);
            const { file: doc, author } = s.store.meta;
            const { threads } = JSON.parse(fs.readFileSync(path.join(s.store.pkg, 'comments.json'), 'utf8'));
            const unread = unreadThreads(doc, author, threads);
            return out(200, { doc, threads, unread, applied: ops.map((e: OpEnvelope) => ({ opId: e.opId, seq: 0 })), rejected: [] });
        }
        return out(404, { code: 'not_found' });
    }
    catch (e) {
        return out((e as any).status ?? 400, { error: (e as Error).message, code: (e as any).code ?? 'invalid' });
    }
}

process.on('exit',()=>{for(const s of sessions.values())if(!s.stopped){try{checkpointSession(s);}catch{}}});
