import { evictClosedPackages } from "./cloud-files-cache.ts";
import { importDocument } from "./cloud-files-import.ts";
// Open Cloud files have one durable replica and one socket. Confirmed state never contains speculative edits.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { target } from './cloud.ts';
import { cloudConfigs, onCloudsChanged, isConfigured, generation, bump, hostedId, waitForShellCloudList } from './cloud-config.ts';
import { FileStateStore } from './cloud-files-store.ts';
import { DocTree } from './cloud-files-tree.ts';
import { documentOf, envelopeOf } from '../cloud/core/files/state.ts';
import { cloudFileHooks } from './cloud-files-runtime.ts';
import { asOneAction, adoptWriters, onAction, envelopeFileOps } from './cloud-files-ops.ts';
import { loadManifest, type Manifest } from '../cloud/core/files/snapshots.ts';
import { type ObjectStore, fromUtf8 } from '../cloud/core/files/objects.ts';
import { type Action, type FileServerMessage, type FileOp, type Role, CAN_EDIT, checkBlobPath, FILE_CAPABILITIES_HEADER, hasWhiteboard, insertsWhiteboard, supportsWhiteboard, UPDATE_WHITEBOARD_HOST, WHITEBOARD } from '../cloud/protocol-files.ts';
import { createPackage, targetPath } from './docpath.ts';
import { type BlobRow } from '../cloud/core/files/seam.ts';
import { readBodyText } from './body.ts';
import { applyOp, CLOUD_VOTES, isVoteOp, LIMITS, supportsCloudVotes, UPDATE_COMMENT_HOST, UPDATE_VOTE_HOST, type CommentsFile, type OpEnvelope, type Thread, type Vote, type VoteView } from '../cloud/protocol.ts';
import { COMMENTS_FILE, forkComments, readCommentsFile, writeCommentsFile } from './comments-file.ts';
import { ownLocalVotes, receiveVoteViews, sendableCommentOps } from './vote-state.ts';
import { prepareMove } from './cloud-files-move.ts';
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
interface Session {
    store: FileStateStore;
    ws?: WebSocket;
    connecting?: boolean;
    initialConnect?: Promise<'missing' | void>;
    importing?: boolean;
    status: string;
    whiteboard?: boolean;
    voting?: boolean;
    serverTime?: string;
    voteClockOffset?: number;
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
export function fileSession(file: string, importing = false): Session | undefined {
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
    s.initialConnect = connect(s);
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
    const s = fileSession(f);
    if (s?.updateMessage) fail(426, 'update', s.updateMessage);
    if (s && !CAN_EDIT[s.store.meta.role]) fail(403, 'read_only', 'This Cloud file is read only');
};
cloudFileHooks.whiteboardIssue = (file, nodes) => {
    const s = fileSession(file);
    return s && s.whiteboard !== true && hasWhiteboard(nodes) ? UPDATE_WHITEBOARD_HOST : undefined;
};
function waitingForHost(s: Session) {
    return s.whiteboard === false && s.store.replica.pending.some(p => insertsWhiteboard(p.action.ops))
        ? 'Edits are waiting for the Cloud host to update Canvas.' : undefined;
}
export function fileInfo(file: string, open = true) { const s = open ? fileSession(file) : sessions.get(docFile(file)); return s ? { author: s.store.meta.author, name: s.store.meta.name, cloud: s.store.meta.cloud, key: cloudKey(s.store.meta.cloud), file: s.store.meta.file, role: s.store.meta.role, status: s.status, whiteboard: s.whiteboard === true, voting: s.voting, serverTime: s.serverTime, voteClockOffset: s.voteClockOffset, updateMessage: s.updateMessage, waitingForHost: waitingForHost(s), pending: s.store.replica.pending.length, refused: s.store.replica.refused.map(r => ({ id: r.action.id, code: r.code, message: r.message })) } : null; }
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
    const r = await fetch((t as any).base + p, { method, headers: { ...(t as any).headers, [FILE_CAPABILITIES_HEADER]: WHITEBOARD + ', ' + CLOUD_VOTES, ...(body === undefined ? {} : { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' }) }, body: body === undefined ? undefined : body instanceof Uint8Array ? body as BodyInit : JSON.stringify(body), signal: AbortSignal.timeout(30000), redirect: 'error' });
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
    await downloadBlobs(cloud, file, s.store.pkg, s.store.replica.tree.state().blobs, () => s.stopped || generation(cloud) !== g);
}
async function downloadBlobs(cloud: string, file: string, pkg: string, blobs: Record<string, BlobRow>, cancelled: () => boolean) {
    for (const [rel, b] of Object.entries(blobs)) {
        if (checkBlobPath(rel))
            throw new Error('Invalid blob path');
        const parent = path.join(pkg, rel.split('/')[0]);
        for (const p of [pkg, parent, path.join(pkg, rel), path.join(pkg, rel) + '.tmp'])
            if (fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
                throw new Error('Cloud cache path is a link');
        const dest = path.join(pkg, rel);
        if (fs.existsSync(dest) && !fs.lstatSync(dest).isSymbolicLink() && createHash('sha256').update(fs.readFileSync(dest)).digest('hex') === b.sha256)
            continue;
        if (b.bytes > 100 * 1024 * 1024)
            throw new Error('Blob exceeds limit');
        const bytes = await boundedBytes(await request(cloud, `/v1/files/${file}/blobs/${b.sha256}`), b.bytes);
        if (createHash('sha256').update(bytes).digest('hex') !== b.sha256 || bytes.length !== b.bytes)
            throw new Error('Blob hash mismatch');
        if (cancelled() || revoked.has(cloud)) throw new Error('Cloud membership was removed during download');
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        fs.writeFileSync(dest + '.tmp', bytes, { mode: 0o600 });
        fs.renameSync(dest + '.tmp', dest);
    }
}
function render(s: Session) { if (s.stopped)
    return; adoptWriters(path.join(s.store.pkg, 'document.json'), s.store.replica.view().allVers()); s.store.materialize(); fileEvents.view?.(path.join(s.store.pkg, 'document.json')); }
function commentState(s: Session): CommentsFile {
    return { format: 1, doc: s.store.meta.file, seq: s.commentsSeq, threads: s.comments, outbox: s.commentsPending,
        rejected: s.commentsRejected ?? [], cloudVotes: s.cloudVotes, voteConclusions: s.voteConclusions };
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
    receiveVoteViews(state, votes);
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
    if (!s.commentsPending.some(e => e.opId === envelope.opId) && !s.commentsRejected?.some(r => r.envelope.opId === envelope.opId)) {
        s.commentsPending.push({ ...envelope, doc: s.store.meta.file });
        saveComments(s);
        sendComments(s);
    }
}
function saveComments(s: Session) {
    s.store.db.prepare('INSERT OR REPLACE INTO comments_state VALUES(1,?)').run(JSON.stringify({ comments: s.comments, commentsSeq: s.commentsSeq, commentsPending: s.commentsPending, commentsRejected: s.commentsRejected ?? [], voting: s.voting, cloudVotes: s.cloudVotes, voteConclusions: s.voteConclusions, legacyVotes: s.legacyVotes, legacyVoteConclusions: s.legacyVoteConclusions, voteQueueVersion: 1 }));
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
    if (m.type === 'comments.snapshot') {
        if (m.votes) saveVoteViews(s, m.votes);
        s.comments = m.threads;
        s.commentsSeq = m.seq;
        saveComments(s);
        fileEvents.comments?.(path.join(s.store.pkg, 'document.json'));
        return;
    }
    if (m.type === 'comments.applied') {
        if (m.votes) saveVoteViews(s, m.votes);
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
        for (const r of m.rejected ?? []) {
            s.commentsInFlight?.delete(r.opId);
            const envelope = s.commentsPending.find(p => p.opId === r.opId);
            if (!envelope) continue;
            if (r.code === 'quota') { waitForQuota(s); continue; }
            (s.commentsRejected ??= []).push({ envelope, code: r.code, message: r.message });
        }
        s.commentsPending = s.commentsPending.filter(p => !m.acks.some((a: any) => a.opId === p.opId && a.seq <= s.commentsSeq) && !m.rejected.some((r: any) => r.opId === p.opId && r.code !== 'quota'));
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
        s.voting = supportsCloudVotes(m.capabilities);
        s.serverTime = m.serverTime;
        s.voteClockOffset = m.serverTime ? Date.parse(m.serverTime) - Date.now() : undefined;
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
    const ops = sendableCommentOps(s.commentsPending, s.store.meta.role, s.voting).slice(0, LIMITS.opsPerMessage);
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
    const actions = s.store.replica.outgoing(100, action => s.whiteboard === true || !insertsWhiteboard(action.ops));
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
    if (s.updateMessage) fail(426, 'update', s.updateMessage);
    if (s.whiteboard !== true && insertsWhiteboard(action.ops)) fail(426, 'update_host', UPDATE_WHITEBOARD_HOST);
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
    const cached = fileSession(pkg, importingName !== undefined);
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
        return { id, file: pkg, name: cached.store.meta.name, cloud, role: cached.store.meta.role };
    }
    const listed = importingName === undefined ? await cloudFiles(cloud) as any : null;
    const item = importingName === undefined ? listed.files?.find((f: any) => f.id === id) : {id,name:importingName};
    if (!item)
        fail(404, 'not_found', 'No such Cloud file');
    let s = sessions.get(path.join(pkg, 'document.json'));
    if (!s && fs.existsSync(path.join(pkg, '.cloud', 'state.sqlite')))
        s = fileSession(pkg, importingName !== undefined);
    if (!s) {
        const me = await cloudJson(await request(cloud, '/v1/me')) as any;
        const m = await cloudJson(await request(cloud, `/v1/files/${id}/manifest`)) as Manifest;
        if (m.file !== id)
            throw new Error('Manifest names another file');
        const { state } = await loadManifest(objects(cloud, id), JSON.stringify(m));
        checkGeneration(cloud, openingGeneration);
        const store = new FileStateStore(pkg, { cloud, file: id, name: item.name, role: me.role, author: { id: me.id, name: me.name }, state });
        store.replica.seq = m.seq;
        store.replica.epoch = m.epoch;
        store.commit();
        store.materialize();
        store.close();
        s = fileSession(pkg, importingName !== undefined)!;
        await cacheBlobs(s);
    }
    if (importingName === undefined && s.store.meta.name !== item.name) {
        s.store.meta.name = item.name;
        s.store.commit();
    }
    evictClosedPackages(root(),new Set([...sessions.values()].map(s=>s.store.pkg)));
    return { id, file: pkg, name: item.name, cloud, role: s.store.meta.role };
}
async function downloadCloudFile(cloud: string, id: string, target: unknown) {
    cloud = resolveCloud(cloud);
    const targetFile = targetPath(target);
    const g = generation(cloud);
    const cancelled = () => generation(cloud) !== g;
    const manifest = await cloudJson(await request(cloud, `/v1/files/${id}/manifest`)) as Manifest;
    if (manifest.file !== id) throw new Error('Manifest names another file');
    const { state } = await loadManifest(objects(cloud, id), JSON.stringify(manifest));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cloud-download-'));
    try {
        await downloadBlobs(cloud, id, dir, state.blobs, cancelled);
        await request(cloud, `/v1/files/${id}`);
        if (cancelled()) fail(403, 'removed', 'Cloud membership was removed during download');
        const tree = DocTree.fromState(state);
        const file = createPackage(targetFile, tmp => {
            fs.writeFileSync(path.join(tmp, 'document.json'), JSON.stringify(documentOf(tree)));
            fs.writeFileSync(path.join(tmp, 'widgets.json'), JSON.stringify(envelopeOf(tree)));
            for (const rel of Object.keys(state.blobs)) {
                const dest = path.join(tmp, rel);
                fs.mkdirSync(path.dirname(dest), { recursive: true });
                fs.copyFileSync(path.join(dir, rel), dest, fs.constants.COPYFILE_FICLONE);
            }
        });
        return { file };
    } finally {
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
            if (p.endsWith('/download')) return out(200, await downloadCloudFile(cloud, id, b.target));
            if (p.endsWith('/duplicate')) return out(201, await cloudJson(await request(cloud, route + '/duplicate', 'POST', {})));
            if (p.endsWith('/delete')) return out(200, await cloudJson(await request(cloud, route, 'DELETE', {})));
            const name = await renameCloudFileById(cloud, id, b.name);
            return out(200, { ok: true, name });
        }
        if (p === '/api/cloud/files/move') {
            if (fileInfo(url.searchParams.get('file')!))
                return out(409, { code: 'conflict', error: 'This file already belongs to a Cloud' });
            let importing: string | undefined;
            try {
            const moved = await prepareMove(url.searchParams.get('file')!, async (name, doc, env, blobs, comments) => {
                if (hasWhiteboard(doc.children) || comments.some(e => isVoteOp(e.op))) {
                    const info = await cloudJson(await request(b.cloud, '/v1/info')) as { capabilities?: unknown };
                    if (comments.some(e => isVoteOp(e.op)) && !supportsCloudVotes(info.capabilities)) fail(426, 'version', UPDATE_VOTE_HOST);
                    if (hasWhiteboard(doc.children) && !supportsWhiteboard(info.capabilities)) fail(426, 'update_host', UPDATE_WHITEBOARD_HOST);
                }
                const created = { id: randomUUID() };
                await request(b.cloud, '/v1/files', 'POST', { id: created.id, name: b.name || name, importing: true, version: doc.version });
                importing=created.id;
                for (const blob of blobs) {
                    const u = await cloudJson(await request(b.cloud, `/v1/files/${created.id}/uploads`, 'POST', blob.op)) as any;
                    await request(b.cloud, `/v1/files/${created.id}/uploads/${u.id}`, 'PUT', blob.bytes);
                }
                const ops: FileOp[] = [...blobs.map(v => v.op), ...importDocument(doc), ...envelopeFileOps({ widgets: [], extra: {} }, { widgets: env.widgets as Record<string, unknown>[] ?? [], extra: Object.fromEntries(Object.entries(env).filter(([k]) => k !== 'widgets' && k !== 'version')) })];
                const actions: Action[] = [];
                let seq = 0;
                for (let i = 0; i < ops.length; i += 100) {
                    const a = { id: randomUUID(), baseSeq: seq, epoch: 1, ops: ops.slice(i, i + 100), at: new Date().toISOString() };
                    const out = await cloudJson(await request(b.cloud, `/v1/files/${created.id}/sync`, 'POST', { type: 'actions', epoch: 1, actions: [a] })) as any;
                    const rejected = (out.messages as FileServerMessage[]).find(m => m.type === 'reject' || m.type === 'error');
                    if (rejected && (rejected.type === 'reject' || rejected.type === 'error'))
                        fail(400, rejected.code, `Cloud refused import (${rejected.code}): ${rejected.message}`);
                    seq += a.ops.length;
                    actions.push(a);
                }
                let social: { seq: number; threads: Thread[]; votes?: VoteView[] } | undefined;
                for (let i = 0; i < comments.length; i += LIMITS.opsPerMessage) {
                    let ops = comments.slice(i, i + LIMITS.opsPerMessage).map(e => ({ ...e, doc: created.id }));
                    while (ops.length) {
                        const out = await cloudJson(await request(b.cloud, `/v1/files/${created.id}/comments`, 'POST', { ops }));
                        const hard = out.rejected.find((r: { code: string; message?: string }) =>
                            r.code !== 'quota' || !/minute/i.test(r.message ?? ''));
                        if (hard) throw new Error(hard.message ?? 'Cloud refused imported comments or votes');
                        social = { seq: out.seq, threads: out.threads, votes: out.votes };
                        const retry = new Set(out.rejected.map((r: { opId: string }) => r.opId));
                        ops = ops.filter(e => retry.has(e.opId));
                        if (ops.length) await delay(Math.min(60_100, Math.max(100, Number(out.retryAfterMs) || 60_100)));
                    }
                }
                // Seed the cache from the confirmed import response. The room socket can welcome the file later.
                const opened = await openCloudFile(b.cloud, created.id, b.name || name);
                if (social) {
                    const doc = docFile(opened.file), session = sessions.get(doc)!;
                    const snapshot = social;
                    await asOneAction(doc, () => snapshot.seq >= session.commentsSeq
                        ? receive(session, { type: 'comments.snapshot', ...snapshot }) : undefined);
                }
                return opened;
            }, async dest => {
                await request(b.cloud, `/v1/files/${dest.id}/import/complete`, 'POST', {});
                const session = sessions.get(docFile(dest.file));
                if (session) session.importing = false;
            });
            return out(200, moved);
            } catch(error) {
                fileEvents.problem?.((error as Error).message);
                if(importing) {
                    // A publication can succeed even when its response is lost. Never cancel a live file.
                    const state = await cloudJson(await request(b.cloud, `/v1/files/${importing}`));
                    if (state.state !== 'importing') throw new Error((error as Error).message + '; local source kept. The Cloud file is published');
                    const pkg=path.join(root(),cloudKey(resolveCloud(b.cloud)),importing+'.canvas'), file=path.join(pkg,'document.json'), s=sessions.get(file);
                    if(s) {s.stopped=true;clearPresence(s);if(s.timer)clearTimeout(s.timer);s.ws?.close();await s.chain.catch(()=>{});s.store.close();sessions.delete(file);fileEvents.removed?.(file);}
                    fs.rmSync(pkg,{recursive:true,force:true});
                    try {await request(b.cloud,`/v1/files/${importing}/import`,'DELETE',{});}
                    catch(cleanup) {throw new Error((error as Error).message+'; local source kept. Cloud cleanup: '+(cleanup as Error).message);}
                }
                throw error;
            }
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
