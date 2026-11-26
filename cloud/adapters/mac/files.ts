// Disk objects and file rooms for a Mac hosted Cloud. Identity is checked before touching a room or an object.
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { roomHasSocialDeadline, SqliteStore } from "./sqlite.ts";
import { MacUsage, macUsageTone } from './usage.ts';
import { PresenceLimiter, receivePresence, snapshotFor, goneOf, fanOut, type PresenceSocket, type KeptPresence, type PeerPresence } from '../../core/presence.ts';
import { upgrade, type ServerSocket } from "./websocket.ts";
import { FileRoom, type Conn } from "../../core/files/room.ts";
import { RoleCache } from "../../core/files/access.ts";
import { LeaseBank, RoomLeases } from "../../core/files/leases.ts";
import { StorageLedger, reserveUpload, putUpload, UploadError, UPLOAD_GRACE_MS } from "../../core/files/uploads.ts";
import { buildSnapshot, recoverSnapshots, compact, type Manifest } from "../../core/files/snapshots.ts";
import { collectGarbage } from "../../core/files/gc.ts";
import { stateFromFiles, stateOf } from "../../core/files/state.ts";
import { type ObjectStore, boardKey, versKey, blobKey } from "../../core/files/objects.ts";
import { isImportUpload, TRANSFER_BATCH_BYTES, TRANSFER_BLOBS, TRANSFER_BLOB_BYTES, TRANSFER_BODY_BYTES, TRANSFER_HEADER_BYTES, TRANSFER_PART_BYTES } from "../../file-transfer.ts";
import { LIMITS, supportsPrivateVoteViews, type OpEnvelope } from "../../protocol.ts";
import { voteDesignForTree } from "../../core/votes.ts";
import { Operations, type OpResult } from "../../core/operations.ts";
import type { Me } from "./host.ts";
import { blobTypeOf, checkBlobPath, FILE_CAPABILITIES_HEADER, type Action, type FileOp, insertsWhiteboard, supportsWhiteboard, WHITEBOARD_UPDATE, type AppliedAction, type FileClientMessage, type Role } from "../../protocol-files.ts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const GB = 1024 ** 3;
// Four maximum-size files per hour, eight starts and bounded DB work. Reads have a separate budget.
const TRANSFER_HOURLY = { starts: 8, inBytes: 4 * GB, outBytes: 12 * GB, blobs: 32_768, ops: 100_000, requests: 1_200 };
const BATCH_DOWNLOADS_PER_PERSON = 2;
const BATCH_DOWNLOADS_TOTAL = 32;
const BATCH_DOWNLOAD_IDLE_MS = 15_000;
function diskBytes(root: string): number {
    let bytes = 0;
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
        if (e.isSymbolicLink())
            continue;
        const p = path.join(root, e.name);
        bytes += e.isDirectory() ? diskBytes(p) : fs.statSync(p).size;
    }
    return bytes;
}
const error = (status: number, code: string, message: string): never => { throw Object.assign(new Error(message), { status, code }); };
export class DiskObjects implements ObjectStore {
    readonly root: string;
    private check?: (bytes: number) => void;
    private changed?: (delta: number) => void;
    constructor(root: string, check?: (bytes: number) => void, changed?: (delta: number) => void) { this.check = check; this.changed = changed; this.root = root; fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
    private at(key: string): string {
        if (!/^files\/[0-9a-f-]{36}\/(boards\/[0-9a-f]{64}\.json\.gz|vers\/[0-9a-f]{64}\.json\.gz|blobs\/[0-9a-f]{64}|manifests\/[0-9]+\.json)$/.test(key) || !UUID.test(key.split('/')[1]))
            throw new Error('Invalid object key');
        let p = this.root;
        for (const part of key.split('/')) {
            p = path.join(p, part);
            if (fs.lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink())
                throw new Error('Object path is a link');
        }
        return p;
    }
    async putIfAbsent(key: string, bytes: Uint8Array) {
        const dest = this.at(key);
        if (fs.existsSync(dest))
            return false;
        this.check?.(bytes.length);
        fs.mkdirSync(path.dirname(dest), { recursive: true, mode: 0o700 });
        const tmp = path.join(path.dirname(dest), `.upload-${randomUUID()}`);
        const fd = fs.openSync(tmp, 'wx', 0o600);
        try {
            fs.writeFileSync(fd, bytes);
            fs.fsyncSync(fd);
        }
        finally {
            fs.closeSync(fd);
        }
        try {
            fs.linkSync(tmp, dest);
            this.changed?.(bytes.length);
            const dir = fs.openSync(path.dirname(dest), 'r');
            try {
                fs.fsyncSync(dir);
            }
            finally {
                fs.closeSync(dir);
            }
            return true;
        }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'EEXIST')
                return false;
            throw e;
        }
        finally {
            fs.unlinkSync(tmp);
        }
    }
    diskFile(key:string):{file:string;bytes:number}|null { const file=this.at(key);const stat=fs.statSync(file,{throwIfNoEntry:false});return stat?.isFile()?{file,bytes:stat.size}:null; }
    async get(key: string) { try {
        return fs.readFileSync(this.at(key));
    }
    catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT')
            return null;
        throw e;
    } }
    async delete(key: string) { const file = this.at(key), bytes = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0; fs.rmSync(file, { force: true }); this.changed?.(-bytes); }
    async list(prefix: string) {
        const out: string[] = [];
        const walk = (dir: string, rel: string) => { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isSymbolicLink())
                continue;
            const k = rel + e.name;
            if (e.isDirectory())
                walk(path.join(dir, e.name), k + '/');
            else if (k.startsWith(prefix) && !e.name.startsWith('.'))
                out.push(k);
        } };
        walk(this.root, '');
        return out.sort();
    }
}
interface Row extends Record<string, string | number | null> {
    id: string;
    name: string;
    state: string;
    created_by: string;
    updated_at: string;
}
const canDelete = (row: Row, me: Me) => me.role === 'owner' || (me.role === 'editor' && row.created_by === me.id);
interface Room {
    leases: RoomLeases;
    store: SqliteStore;
    core: FileRoom;
    comments: Operations;
    roles: RoleCache;
    sockets: Map<ServerSocket, Me>;
    ready: Map<ServerSocket, boolean>;
    presence: Map<ServerSocket, { socket: PresenceSocket; kept: KeptPresence }>;
    lastAction: number;
    snapshotAt: number;
    timer?: ReturnType<typeof setTimeout>;
    voteTimer?: ReturnType<typeof setTimeout>;
    privateVoting?: boolean;
}
export class MacFiles {
    readonly objects: DiskObjects;
    private readonly db: SqliteStore;
    private readonly root: string;
    private readonly rooms = new Map<string, Room>();
    private readonly presenceLimiter = new PresenceLimiter();
    private readonly downloads = new Map<http.ServerResponse, Me>();
    private readonly batchDownloads = new Map<http.ServerResponse, string>();
    private readonly bank: LeaseBank;
    private readonly importBank: LeaseBank;
    private readonly ledger: StorageLedger;
    private readonly current: (me: Me) => Me | null;
    private readonly role: (person: string) => Role | null;
    private readonly now: () => number;
    private readonly meter: MacUsage;
    private cap: number;
    private inFlight = 0;
    private bodies = 0;
    private usedBytes = 0;
    private readonly dbBytes = new Map<string, number>();
    private readonly partBytes = new Map<string, number>();
    private readonly activeParts = new Set<string>();
    private readonly activeImports = new Set<string>();
    private readonly reservedTransferInput = new Map<string, number>();
    private readonly sweepTimer: NodeJS.Timeout;
    constructor(root: string, db: SqliteStore, current: (me: Me) => Me | null, role: (person: string) => Role | null, now = Date.now, cap = 20 * GB) {
        this.cap = cap;
        this.root = root;
        this.db = db;
        this.current = current;
        this.role = role;
        this.now = now;
        this.meter = new MacUsage(db, now);
        fs.mkdirSync(path.join(root, 'files'), { recursive: true, mode: 0o700 });
        this.objects = new DiskObjects(path.join(root, 'objects'), bytes => this.capacity(bytes), delta => { this.usedBytes += delta; });
        db.sql.exec(`CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
        db.sql.exec("CREATE TABLE IF NOT EXISTS file_transfer_usage(person TEXT, hour INTEGER, kind TEXT, used INTEGER, PRIMARY KEY(person,hour,kind))");
        db.sql.exec("CREATE TABLE IF NOT EXISTS file_transfer_moves(file TEXT PRIMARY KEY, token TEXT NOT NULL)");
        db.sql.exec("CREATE TABLE IF NOT EXISTS file_transfer_imports(file TEXT PRIMARY KEY, source_visible INTEGER NOT NULL DEFAULT 0)");
        if (!db.sql.exec("SELECT 1 FROM pragma_table_info('file_transfer_imports') WHERE name='source_visible'").toArray().length)
            db.sql.exec("ALTER TABLE file_transfer_imports ADD COLUMN source_visible INTEGER NOT NULL DEFAULT 0");
        this.bank = new LeaseBank(db);
        this.importBank = new LeaseBank(db, { ops: 6000, messages: 120, presence: 0 });
        this.ledger = new StorageLedger(db, cap);
        this.sweepParts();
        this.recount();
        for (const { id } of db.sql.exec<{ id: string }>("SELECT id FROM files WHERE state != 'trash'").toArray())
            if (UUID.test(id) && roomHasSocialDeadline(path.join(root, 'files', id + '.sqlite'))) this.room(id);
        this.sweepTimer = setInterval(() => { this.sweepParts(); void this.expireImports().catch(() => {}).finally(() => this.recount()); }, 60_000); this.sweepTimer.unref();
    }
    private accountDatabase(file: string) {
        const bytes = ['', '-wal', '-shm'].reduce((n, suffix) => n + (fs.statSync(file + suffix, { throwIfNoEntry: false })?.size ?? 0), 0);
        this.usedBytes += bytes - (this.dbBytes.get(file) ?? 0); this.dbBytes.set(file, bytes);
    }
    private recount() {
        this.dbBytes.clear(); this.usedBytes = 0;
        this.accountDatabase(path.join(this.root, 'team.sqlite'));
        for (const file of fs.readdirSync(path.join(this.root, 'files'))) if (file.endsWith('.sqlite')) this.accountDatabase(path.join(this.root, 'files', file));
        this.usedBytes = diskBytes(this.root);
    }
    private removeParts(folder: string) {
        if (fs.existsSync(folder) && !fs.lstatSync(folder).isSymbolicLink()) this.usedBytes -= diskBytes(folder);
        fs.rmSync(folder, { recursive: true, force: true }); this.partBytes.delete(folder);
    }
    private discardImport(file: string) {
        const r = this.rooms.get(file);
        if (r) {
            if (r.timer) clearTimeout(r.timer);
            clearTimeout(r.voteTimer);
            for (const ws of r.sockets.keys()) ws.close(1008, 'Import cancelled');
            r.presence.clear(); r.sockets.clear(); r.store.close(); this.rooms.delete(file);
        }
        for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(this.root, 'files', file + '.sqlite' + suffix), { force: true });
        this.accountDatabase(path.join(this.root, 'files', file + '.sqlite'));
        const objects = path.join(this.objects.root, 'files', file);
        if (fs.existsSync(objects)) { this.usedBytes -= diskBytes(objects); fs.rmSync(objects, { recursive: true, force: true }); }
        const parts = path.join(this.root, 'uploads', file);
        if (fs.existsSync(parts)) { for (const id of fs.readdirSync(parts)) this.removeParts(path.join(parts, id)); fs.rmSync(parts, { recursive: true, force: true }); }
        this.db.sql.exec('DELETE FROM storage_held WHERE key LIKE ?', `${file}/%`);
        this.db.sql.exec('DELETE FROM file_transfer_imports WHERE file=?', file);
        this.db.sql.exec('DELETE FROM files WHERE id=?', file);
    }
    async expireImports() {
        const cutoff = new Date(this.now() - 24 * 60 * 60 * 1000).toISOString();
        // Older transfer clients could have parked their only local copy before sending the publish request.
        for (const row of this.db.sql.exec<{id:string}>(`SELECT id FROM files WHERE state='importing' AND created_at<=?
            AND NOT EXISTS (SELECT 1 FROM file_transfer_imports WHERE file=id AND source_visible=0)`, cutoff).toArray()) {
            if (this.activeImports.has(row.id) || [...this.activeParts].some(p => p.startsWith(path.join(this.root, 'uploads', row.id) + path.sep))) continue;
            const r = this.room(row.id);
            await r.core.exclusive(async () => {
                if (!this.activeImports.has(row.id) && this.db.sql.exec("SELECT 1 FROM files WHERE id=? AND state='importing' AND created_at<=?", row.id, cutoff).toArray().length) this.discardImport(row.id);
            });
        }
    }
    sweepParts() {
        const root = path.join(this.root, 'uploads');
        if (!fs.existsSync(root)) return;
        for (const file of fs.readdirSync(root)) {
            if (!UUID.test(file)) continue;
            const dir = path.join(root, file);
            if (fs.lstatSync(dir).isSymbolicLink()) continue;
            const exists = this.db.sql.exec('SELECT 1 FROM files WHERE id=?', file).toArray().length;
            for (const id of fs.readdirSync(dir)) {
                const folder = path.join(dir, id);
                if ([...this.activeParts].some(p => p.startsWith(folder + path.sep))) continue;
                const up = exists ? this.room(file).store.sql.exec<{state:string;at_ms:number}>('SELECT state,at_ms FROM uploads WHERE id=?', id).toArray()[0] : null;
                if (!up || up.state !== 'open' || this.now() - up.at_ms >= UPLOAD_GRACE_MS) {
                    this.removeParts(folder);
                }
            }
        }
    }
    private row(file: string, me: Me): Row {
        if (!this.current(me))
            error(401, 'removed', 'This device was removed');
        if (!UUID.test(file))
            error(400, 'invalid', 'File must be a uuid');
        const row = this.db.sql.exec<Row>('SELECT * FROM files WHERE id=?', file).toArray()[0];
        if (!row || (row.state === 'importing' && row.created_by !== me.id) || (row.state === 'trash' && row.created_by !== me.id && me.role !== 'owner'))
            error(404, 'not_found', 'No such file');
        return row;
    }
    private room(file: string): Room {
        let r = this.rooms.get(file);
        if (!r) {
            const store = new SqliteStore(path.join(this.root, 'files', file + '.sqlite'));
            store.db.exec('PRAGMA synchronous=FULL');
            const roles = new RoleCache({ role: this.role }, this.now);
            const leases = new RoomLeases({ grant: (person, kind, want, now) => {
                    const importing = this.db.sql.exec<{
                        state: string;
                    }>('SELECT state FROM files WHERE id=?', file).toArray()[0]?.state === 'importing';
                    return importing && kind === 'ops' ? this.importBank.grant('import:' + person, kind, want, now) : this.bank.grant(person, kind, want, now);
                } }, this.now);
            const core = new FileRoom({ store, file, objects: this.objects, roles, leases, now: this.now });
            recoverSnapshots(core);
            const comments = new Operations(store, () => this.now());
            if (!store.sql.exec("SELECT 1 AS one FROM pragma_table_info('ops') WHERE name = 'by_id'").toArray().length)
                store.sql.exec('ALTER TABLE ops ADD COLUMN by_id TEXT');
            r = { leases, store, core, roles, comments, sockets: new Map(), ready: new Map(), presence: new Map(), lastAction: 0, snapshotAt: this.now() };
            this.rooms.set(file, r);
            const room = r;
            comments.onVotesExpired = entries => this.broadcastComments(room, entries);
            room.privateVoting = comments.privateVoting();
            this.scheduleVoteExpiry(room);
            this.accountDatabase(path.join(this.root, 'files', file + '.sqlite'));
        }
        return r;
    }
    private conn(me: Me): Conn { return { author: { id: me.id, name: me.name }, role: me.role }; }
    private relayPresence(r: Room, from: PresenceSocket, peer: PeerPresence) {
        const recipients = new Set(fanOut([...r.presence.values()].map(p => p.socket), from));
        for (const [ws, p] of r.presence) {
            const me = r.sockets.get(ws);
            if (recipients.has(p.socket.session) && me && this.current(me)) ws.send(JSON.stringify({ type: 'presence', peers: [peer] }));
        }
    }
    recheck() {
        for(const [res,me] of this.downloads)if(!this.current(me)){this.downloads.delete(res);res.destroy();}
        for (const r of this.rooms.values())
            for (const [ws, me] of r.sockets) {
                const fresh = this.current(me);
                r.roles.push(me.id, fresh?.role ?? null);
                if (!fresh) {
                    ws.send(JSON.stringify({ type: 'removed' }));
                    ws.close(1008, 'removed');
                    r.sockets.delete(ws);
                }
                else {
                    r.sockets.set(ws, fresh);
                    if (fresh.role !== me.role) {
                        ws.send(JSON.stringify({ type: 'role', role: fresh.role }));
                    }
                }
            }
    }
    private readonly votingSockets = new WeakSet<ServerSocket>();
    private scheduleVoteExpiry(r: Room) {
        clearTimeout(r.voteTimer);
        const next = r.comments.nextVoteExpiry();
        r.voteTimer = next === undefined ? undefined : setTimeout(() => {
            r.comments.expireDueVotes();
            this.scheduleVoteExpiry(r);
        }, Math.max(1, next - this.now()));
        r.voteTimer?.unref();
    }
    private submitComments(r: Room, ops: unknown[], me: Me, allowance: number, voting: boolean): OpResult {
        try {
            return this.bounded(r, () => r.comments.submit(r.core.file, ops, me, me.role, allowance, [],
                voting ? voteDesignForTree(r.core.tree) : undefined));
        } catch (error) {
            if (!(error instanceof Error) || !('code' in error) || error.code !== 'quota') throw error;
            const rejected = ops.flatMap(op => op && typeof op === 'object' && 'opId' in op && typeof op.opId === 'string'
                ? [{ opId: op.opId, code: 'storage_quota' as const, message: error.message }]
                : []);
            return { acks: [], entries: [], rejected };
        }
    }
    private broadcastComments(r: Room, entries: OpResult['entries']) {
        const changed = entries.some(entry => entry.op.kind === 'vote.changed');
        this.recheck();
        if (changed) {
            const privateVoting = r.comments.privateVoting();
            if (privateVoting && !r.privateVoting) {
                for (const { socket } of r.presence.values()) {
                    this.relayPresence(r, socket, { ...goneOf(socket), gone: undefined, page: null, cursor: null, sel: [], preview: null, editing: null });
                }
                for (const peer of r.presence.values()) peer.kept = {};
            }
            r.privateVoting = privateVoting;
        }
        for (const [ws, me] of r.sockets) {
            if (!r.ready.has(ws)) continue;
            ws.send(JSON.stringify({ type: 'comments.applied', entries,
                ...(changed && this.votingSockets.has(ws) && r.comments.socialView(me)),
            }));
        }
    }
    private broadcastActions(r: Room, actions: AppliedAction[]) {
        this.recheck();
        const whiteboard = [...r.ready.values()].includes(false) && (actions.some(a => insertsWhiteboard(a.ops)) || r.core.hasWhiteboard());
        const message = JSON.stringify({ type: 'applied', actions });
        for (const ws of r.sockets.keys()) {
            const capable = r.ready.get(ws);
            if (capable === undefined) continue;
            if (whiteboard && !capable) {
                r.ready.delete(ws);
                ws.send(JSON.stringify(WHITEBOARD_UPDATE));
                ws.close(1008, WHITEBOARD_UPDATE.message);
            } else ws.send(message);
        }
    }
    private bounded<T>(r: Room, fn: () => T): T {
        this.capacity(0);
        try {
            return r.store.transactionSync(() => {
                const out = fn();
                // WAL commits can write at most the database's page count once. Reserve that upper bound before COMMIT.
                const pages = Number(r.store.db.prepare('PRAGMA page_count').get()!.page_count), size = Number(r.store.db.prepare('PRAGMA page_size').get()!.page_size);
                this.capacity(pages * size);
                return out;
            });
        }
        catch (e) {
            r.core.tree.forget();
            throw e;
        }
        finally { this.accountDatabase(path.join(this.root, 'files', r.core.file + '.sqlite')); this.accountDatabase(path.join(this.root, 'team.sqlite')); }
    }
    private changed(r: Room) {
        this.db.sql.exec('UPDATE files SET updated_at=? WHERE id=?', new Date(this.now()).toISOString(), r.core.file);
        r.lastAction++;
        if (r.timer)
            clearTimeout(r.timer);
        const take = async () => { try { await buildSnapshot(r.core); compact(r.core); await collectGarbage(r.core, this.ledger); r.lastAction = 0; r.snapshotAt = this.now(); } finally { this.accountDatabase(path.join(this.root, 'files', r.core.file + '.sqlite')); } };
        r.timer = setTimeout(() => void take().catch(() => { }), r.lastAction >= 2000 ? 0 : 300000);
        r.timer.unref();
    }
    private edit(me: Me) { const fresh = this.current(me); if (!fresh)
        error(401, 'removed', 'This device was removed'); if (fresh!.role !== 'owner' && fresh!.role !== 'editor')
        error(403, 'read_only', 'This Cloud file is read only'); return fresh!; }
    private capacity(bytes: number) { if (this.usedBytes + bytes > this.cap)
        error(429, 'quota', "This Cloud is full. Delete files to make room."); }
    private disk() { const s = fs.statfsSync(this.root); return s.bavail * s.bsize; }
    private storage(): number { return fs.readdirSync(path.join(this.root, 'files')).reduce((n, f) => n + fs.statSync(path.join(this.root, 'files', f)).size, 0) + this.ledger.held(); }
    private async duplicate(source: Row, me: Me) {
        const room = this.room(source.id).core;
        return room.exclusive(async () => {
            const editor = this.edit(me);
            const row = this.row(source.id, editor);
            if (row.state !== 'live') error(404, 'not_found', 'No such Cloud file');
            const id = randomUUID(), name = row.name.slice(0, 195) + ' copy';
            const state = stateOf(room.tree);
            state.vers = {};
            const blobs = new Map(Object.values(state.blobs).map(blob => [blob.sha256, blob]));
            const blobBytes = [...blobs.values()].reduce((total, blob) => total + blob.bytes, 0);
            this.capacity(1024 * 1024 + blobBytes);
            const teamDb = path.join(this.root, 'team.sqlite');
            const copyDb = path.join(this.root, 'files', id + '.sqlite');
            const now = new Date(this.now()).toISOString();
            this.db.sql.exec("INSERT INTO files VALUES(?,?,'importing',?,?,?)", id, name, editor.id, now, now);
            try {
                this.accountDatabase(teamDb);
                for (const { sha256, bytes } of blobs.values()) {
                    this.capacity(bytes);
                    if (this.bodies >= 4 || this.inFlight + bytes > 256 * 1024 * 1024)
                        error(503, 'quota', 'Uploads are busy; try again');
                    this.bodies++;
                    this.inFlight += bytes;
                    try {
                        const data = await this.objects.get(blobKey(row.id, sha256));
                        if (!data || data.length !== bytes) throw new Error('Missing Cloud file asset');
                        this.edit(me);
                        await this.objects.putIfAbsent(blobKey(id, sha256), data);
                    } finally {
                        this.bodies--;
                        this.inFlight -= bytes;
                    }
                }
                const dest = this.room(id);
                this.bounded(dest, () => dest.core.seedState(state));
                await buildSnapshot(dest.core);
                this.edit(me);
                if (this.row(row.id, me).state !== 'live') error(404, 'not_found', 'No such Cloud file');
                this.accountDatabase(copyDb);
                this.db.sql.exec("UPDATE files SET state='live' WHERE id=?", id);
                this.accountDatabase(teamDb);
                this.capacity(0);
                return { id, name };
            } catch (e) {
                this.discardImport(id);
                throw e;
            } finally {
                this.accountDatabase(copyDb);
                this.accountDatabase(teamDb);
            }
        });
    }
    private transferQuota(me: Me, kind: keyof typeof TRANSFER_HOURLY, amount: number, hour = Math.floor(this.now() / 3_600_000)) {
        this.db.transactionSync(() => {
            this.db.sql.exec('DELETE FROM file_transfer_usage WHERE hour < ?', hour - 1);
            const used = this.transferUsed(me, kind, hour);
            if (used + amount > TRANSFER_HOURLY[kind]) error(429, 'transfer_quota', 'Cloud file transfer limit reached for this hour');
            this.db.sql.exec('INSERT INTO file_transfer_usage VALUES(?,?,?,?) ON CONFLICT(person,hour,kind) DO UPDATE SET used=used+excluded.used', me.id, hour, kind, amount);
        });
    }

    private transferUsed(me: Me, kind: keyof typeof TRANSFER_HOURLY, hour: number) {
        return this.db.sql.exec<{ used: number }>('SELECT used FROM file_transfer_usage WHERE person=? AND hour=? AND kind=?', me.id, hour, kind).toArray()[0]?.used ?? 0;
    }

    private meterTransferInput(me: Me, length: number) {
        const hour = Math.floor(this.now() / 3_600_000), key = `${me.id}/${hour}`;
        const held = this.reservedTransferInput.get(key) ?? 0;
        if (this.transferUsed(me, 'inBytes', hour) + held + length > TRANSFER_HOURLY.inBytes)
            error(429, 'transfer_quota', 'Cloud file transfer limit reached for this hour');
        this.reservedTransferInput.set(key, held + length);
        let received = 0;
        return {
            add: (bytes: number) => { received += bytes; },
            release: () => {
                const remaining = this.reservedTransferInput.get(key)! - length;
                if (remaining) this.reservedTransferInput.set(key, remaining);
                else this.reservedTransferInput.delete(key);
                if (received) this.transferQuota(me, 'inBytes', received, hour);
            },
        };
    }

    private async importBlobs(req: http.IncomingMessage, r: Room, me: Me) {
        const length = Number(req.headers['content-length']);
        if (!Number.isSafeInteger(length) || length < 5 || length > TRANSFER_BODY_BYTES)
            error(413, 'quota', 'Invalid import batch length');
        if (this.bodies >= 4 || this.inFlight + length > 256 * 1024 * 1024)
            error(503, 'quota', 'Uploads are busy; try again');
        if (this.disk() < 5 * GB) error(507, 'quota', 'Less than 5 GB free disk');
        const meter = this.meterTransferInput(me, length);
        this.bodies++;
        this.inFlight += length;
        try {
            const bytes = Buffer.allocUnsafe(length);
            let offset = 0;
            for await (const chunk of req) {
                meter.add(chunk.length);
                this.edit(me);
                if (offset + chunk.length > length) error(413, 'quota', 'Import batch is too large');
                bytes.set(chunk, offset);
                offset += chunk.length;
            }
            const end = 4 + bytes.readUInt32BE();
            if (offset !== length || end > length || end > TRANSFER_HEADER_BYTES + 4)
                error(400, 'invalid', 'Invalid import batch header');
            let list: Extract<FileOp, { k: 'blob' }>[];
            try { list = JSON.parse(bytes.toString('utf8', 4, end)); }
            catch { return error(400, 'invalid', 'Invalid import batch JSON'); }
            if (!Array.isArray(list) || !list.length || list.length > TRANSFER_BLOBS || (list.length > 1 && length - end > TRANSFER_BATCH_BYTES))
                error(400, 'invalid', 'Invalid import batch size');
            let total = 0;
            const hashes = new Set<string>();
            for (const b of list) {
                if (!b || b.k !== 'blob' || checkBlobPath(b.path) || blobTypeOf(b.path) !== b.type
                    || typeof b.sha256 !== 'string' || !SHA.test(b.sha256) || hashes.has(b.sha256)
                    || !Number.isSafeInteger(b.bytes) || b.bytes <= 0 || b.bytes > TRANSFER_BLOB_BYTES)
                    error(400, 'invalid', 'Invalid import blob');
                hashes.add(b.sha256);
                total += b.bytes;
            }
            if (total !== length - end) error(400, 'invalid', 'Import batch byte count differs');
            this.transferQuota(me, 'blobs', list.length);
            offset = end;
            for (const b of list) {
                const conn = this.conn(this.edit(me)), id = randomUUID();
                this.capacity(b.bytes);
                reserveUpload(r.core, this.ledger, conn, { ...b, id });
                await putUpload(r.core, this.ledger, conn, id, bytes.subarray(offset, offset + b.bytes));
                offset += b.bytes;
            }
        } finally {
            this.bodies--;
            this.inFlight -= length;
            meter.release();
        }
    }

    private sendBlobBatch(res: http.ServerResponse, r: Room, me: Me, hashes: unknown) {
        if (!Array.isArray(hashes) || !hashes.length || hashes.length > TRANSFER_BLOBS
            || hashes.some(h => typeof h !== 'string' || !SHA.test(h)) || new Set(hashes).size !== hashes.length)
            return error(400, 'invalid', 'Invalid blob batch');
        if ([...this.batchDownloads.values()].filter(person => person === me.id).length >= BATCH_DOWNLOADS_PER_PERSON)
            error(429, 'quota', 'Too many downloads for this person; try again');
        if (this.batchDownloads.size >= BATCH_DOWNLOADS_TOTAL)
            error(503, 'quota', 'Downloads are busy; try again');
        const objects = hashes.map(sha => {
            const blob = r.store.sql.exec<{ bytes: number }>('SELECT bytes FROM blobs WHERE sha256=? LIMIT 1', sha).toArray()[0];
            if (!blob) return error(404, 'not_found', 'Blob is not in this file');
            const object = this.objects.diskFile(blobKey(r.core.file, sha));
            if (!object || object.bytes !== blob.bytes) return error(409, 'integrity', 'A stored blob is missing or incomplete');
            return object;
        });
        const bytes = objects.reduce((total, b) => total + b.bytes, 0);
        if (bytes > (objects.length === 1 ? TRANSFER_BLOB_BYTES : TRANSFER_BATCH_BYTES))
            error(413, 'quota', 'Blob batch is too large');
        this.transferQuota(me, 'outBytes', bytes);
        let stream: fs.ReadStream | undefined;
        this.downloads.set(res, me);
        this.batchDownloads.set(res, me.id);
        res.once('close', () => {
            this.downloads.delete(res);
            this.batchDownloads.delete(res);
            stream?.destroy();
        });
        res.setTimeout(BATCH_DOWNLOAD_IDLE_MS, () => res.destroy());
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': String(bytes),
            'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
        const next = (index: number) => {
            if (res.destroyed || !this.current(me)) { res.destroy(); return; }
            if (index === objects.length) { res.end(); return; }
            stream = fs.createReadStream(objects[index].file);
            stream.once('error', () => res.destroy());
            stream.once('end', () => next(index + 1));
            stream.pipe(res, { end: false });
        };
        next(0);
        return true;
    }

    async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, me: Me, body: () => Promise<any>): Promise<boolean> {
        if (!(url.pathname === '/v1/usage' || url.pathname === '/v1/files' || url.pathname.startsWith('/v1/files/')))
            return false;
        const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); return true; };
        let touched: string | undefined, activeImportUpload: string | undefined;
        try {
            const p = url.pathname, method = req.method ?? 'GET';
            this.meter.message();
            if (p === '/v1/usage') {
                if (me.role !== 'owner')
                    return json(403, { code: 'forbidden', message: 'Owner role required' });
                const freeDisk = this.disk(), storageBytes = this.usedBytes;
                const stats = this.meter.read();
                return json(200, { adapter: 'mac', storageBytes, freeDisk, peopleConnected: new Set([...this.rooms.values()].flatMap(r => [...r.sockets.values()].map(m => m.id))).size, ...stats, estimated: true, tone: macUsageTone(freeDisk, storageBytes, stats.restartsHour), brake: freeDisk < 5 * GB ? 'storage' : 'none' });
            }
            if (p === '/v1/files') {
                if (method === 'GET') {
                    const query = url.searchParams.get('q')?.toLowerCase() ?? '';
                    const files = this.db.sql.exec<Row>("SELECT * FROM files WHERE state='live' ORDER BY updated_at DESC,id").toArray()
                        .filter(row => row.name.toLowerCase().includes(query))
                        .map(row => ({ ...row, can_delete: canDelete(row, me) }));
                    return json(200, { files, role: me.role });
                }
                if (method !== 'POST')
                    return json(405, { code: 'invalid' });
                this.edit(me);
                this.capacity(1024 * 1024);
                const b = await body();
                this.edit(me);
                const id = b.id ?? randomUUID();
                if (!UUID.test(id) || typeof b.name !== 'string' || !b.name.trim() || b.name.length > 200)
                    return json(400, { code: 'invalid', message: 'A file needs a uuid and name' });
                if (this.db.sql.exec('SELECT 1 FROM files WHERE id=? UNION SELECT 1 FROM documents WHERE doc=?', id, id).toArray().length)
                    return json(409, { code: 'conflict', message: 'File id is taken' });
                if (b.importing === true) this.transferQuota(me, 'starts', 1);
                this.db.transactionSync(() => {
                    this.db.sql.exec("INSERT INTO files VALUES(?,?,?,?,?,?)", id, b.name, b.importing === true ? 'importing' : 'live', me.id, new Date(this.now()).toISOString(), new Date(this.now()).toISOString());
                    if (b.importing === true && b.transfer === true)
                        this.db.sql.exec('INSERT INTO file_transfer_imports(file,source_visible) VALUES(?,?)', id, b.sourceVisible === true ? 1 : 0);
                });
                const r = this.room(id);
                touched = id;
                r.core.seedState(stateFromFiles({ version: typeof b.version === 'string' && /^2\.\d{1,3}$/.test(b.version) ? b.version : '2.21', children: [] }));
                await buildSnapshot(r.core);
                return json(201, { id, name: b.name });
            }
            const m = /^\/v1\/files\/([^/]+)(?:\/(.*))?$/.exec(p)!;
            const file = m[1], sub = m[2] ?? '';
            const blobBatch = sub === 'blob-batch' && method === 'POST';
            const importBatch = (sub === 'import/blobs' && method === 'PUT') || (method === 'POST' && ['import/actions', 'import/comments'].includes(sub));
            const importUpload = isImportUpload(sub, method);
            if (blobBatch || importBatch || importUpload) this.transferQuota(me, 'requests', 1);
            const row = this.row(file, me);
            const batchImport = this.db.sql.exec('SELECT 1 FROM file_transfer_imports WHERE file=?', file).toArray().length > 0;
            touched = file;
            if (!['GET', 'HEAD'].includes(method) && sub !== 'sync' && sub !== 'comments' && !blobBatch)
                this.edit(me);
            if (row.state === 'trash' && !(sub === 'move' && method === 'DELETE'))
                return json(404, { code: 'not_found', message: 'File is in Trash' });
            if (!sub && method === 'GET') return json(200, row);
            if (sub === 'import/complete' && method === 'POST' && batchImport && row.created_by === me.id && row.state === 'live')
                return json(200, { ok: true });
            if ((sub === 'import' || sub === 'import/complete' || importBatch || importUpload) && row.state !== 'importing')
                return json(409, { code: 'conflict', message: 'This file is already published' });
            if (batchImport && row.state === 'importing' &&
                (!['', 'manifest', 'import', 'import/complete', 'blob-batch', 'comments', 'import/blobs', 'import/actions', 'import/comments'].includes(sub)
                    && !importUpload && !/^(boards|vers)\/[0-9a-f]{64}$/.test(sub)
                    || (sub === 'comments' && method !== 'GET') || (sub === 'import' && method !== 'DELETE')))
                return json(409, { code: 'conflict', message: 'The file is still importing' });
            if (sub === 'duplicate' && method === 'POST') {
                await body();
                return json(201, await this.duplicate(row, me));
            }
            if (!sub && method === 'PATCH') {
                const b = await body();
                this.edit(me);
                const name = typeof b?.name === 'string' ? b.name.replace(/[\p{Cc}\p{Bidi_Control}]/gu, '').trim() : '';
                if (!name || name.length > 200)
                    return json(400, { code: 'invalid' });
                if (this.row(file, me).state !== 'live') return json(404, { code: 'not_found' });
                this.db.sql.exec('UPDATE files SET name=?, updated_at=? WHERE id=?', name, new Date(this.now()).toISOString(), file);
                return json(200, { ok: true, name });
            }
            if (sub === 'move' && method === 'GET') {
                if (row.state !== 'live') return json(404, { code: 'not_found' });
                if (!canDelete(row, me)) return json(403, { code: 'forbidden' });
                return json(200, this.room(file).comments.snapshot());
            }
            if ((!sub || sub === 'move') && method === 'DELETE') {
                if (!canDelete(row, me)) return json(403, { code: 'forbidden' });
                const expected = sub === 'move' ? await body() : undefined;
                if (expected?.token !== undefined && (typeof expected.token !== 'string' || !UUID.test(expected.token)))
                    return json(400, { code: 'invalid', message: 'Invalid move token' });
                const completed = () => expected?.token && this.db.sql.exec('SELECT 1 FROM file_transfer_moves WHERE file=? AND token=?', file, expected.token).toArray().length;
                if (row.state === 'trash') return completed() ? json(200, { ok: true }) : json(404, { code: 'not_found' });
                if (row.state !== 'live') return json(404, { code: 'not_found' });
                const r = this.room(file);
                await r.core.exclusive(async () => {
                    const editor = this.edit(me);
                    const current = this.row(file, editor);
                    if (!canDelete(current, editor)) error(403, 'forbidden', 'Only the creator or Cloud owner can delete this file');
                    if (current.state === 'trash' && completed()) return;
                    if (current.state !== 'live') error(404, 'not_found', 'No such Cloud file');
                    if (sub === 'move') {
                        const { seq, epoch } = r.core.meta();
                        if (expected?.seq !== seq || expected?.epoch !== epoch || expected?.commentsSeq !== r.comments.sequence()) {
                            error(409, 'file_changed', 'The Cloud file changed during the move');
                        }
                    }
                    this.db.transactionSync(() => {
                        if (expected?.token) this.db.sql.exec('INSERT INTO file_transfer_moves VALUES(?,?)', file, expected.token);
                        this.db.sql.exec("UPDATE files SET state='trash' WHERE id=?", file);
                    });
                    for (const ws of r.sockets.keys()) ws.close(1008, 'File is in Trash');
                });
                return json(200, { ok: true });
            }
            if (sub === 'import' && method === 'DELETE') {
                if(row.created_by !== me.id) return json(403,{code:'forbidden'});
                const r=this.rooms.get(file) ?? this.room(file);
                await r.core.exclusive(async () => {
                    if (this.row(file, me).state !== 'importing' || this.activeImports.has(file) || [...this.activeParts].some(p => p.startsWith(path.join(this.root,'uploads',file)+path.sep))) error(409,'conflict','Import is published or busy');
                    this.discardImport(file);
                });
                return json(200,{ok:true});
            }
            const r = this.room(file);
            if (sub === 'import' && method === 'POST') {
                if (row.created_by !== me.id)
                    return json(403, { code: 'forbidden' });
                this.db.sql.exec("UPDATE files SET state='importing' WHERE id=?", file);
                return json(200, { ok: true });
            }
            const caps = String(req.headers[FILE_CAPABILITIES_HEADER] ?? '').split(/\s*,\s*/);
            const whiteboard = supportsWhiteboard(caps);
            if (importBatch || (sub === 'import/complete' && method === 'POST')) {
                if (row.created_by !== me.id || (importBatch && !batchImport)) return json(403, { code: 'forbidden' });
                if (this.activeImports.has(file)) return json(409, { code: 'busy', message: 'Import is busy' });
                this.activeImports.add(file);
                try {
                    if (sub === 'import/blobs') {
                        await this.importBlobs(req, r, me);
                        return json(200, { ok: true });
                    }
                    const b = batchImport ? await body() : undefined;
                    const editor = this.edit(me);
                    if (this.row(file, editor).state !== 'importing') return json(409, { code: 'conflict' });
                    if (sub === 'import/actions') {
                        const actions: Action[] = b?.actions;
                        if (!Array.isArray(actions) || !actions.length || actions.length > 40 ||
                            actions.some(a => !Array.isArray(a?.ops) || !a.ops.length || a.ops.length > 100))
                            return json(400, { code: 'invalid', message: 'Invalid batch of import actions' });
                        this.transferQuota(editor, 'ops', actions.reduce((total, a) => total + a.ops.length, 0));
                        for (const a of actions) {
                            const out = this.bounded(r, () => r.core.submit({ ...this.conn(editor), whiteboard }, { type: 'actions', epoch: 1, actions: [a] }, 0, true));
                            const refused = out.replies.find(m => m.type === 'reject' || m.type === 'error');
                            if (refused && (refused.type === 'reject' || refused.type === 'error'))
                                return json(400, { code: refused.code, message: refused.message });
                        }
                        return json(200, { ok: true });
                    }
                    if (sub === 'import/comments') {
                        const ops: OpEnvelope[] = b?.ops;
                        if (!Array.isArray(ops) || !ops.length || ops.length > 1000)
                            return json(400, { code: 'invalid', message: 'Invalid batch of imported comments' });
                        this.transferQuota(editor, 'ops', ops.length);
                        const voting = supportsPrivateVoteViews(caps);
                        for (let i = 0; i < ops.length; i += LIMITS.opsPerMessage) {
                            const batch = ops.slice(i, i + LIMITS.opsPerMessage);
                            const out = this.submitComments(r, batch, editor, batch.length, voting);
                            if (out.rejected.length) return json(400, { code: 'invalid', message: out.rejected[0].message });
                        }
                        this.scheduleVoteExpiry(r);
                        return json(200, { ...r.comments.snapshot(), ...(voting && r.comments.socialView(editor)) });
                    }
                    await buildSnapshot(r.core);
                    this.edit(me);
                    const { seq, epoch } = r.core.meta();
                    if (batchImport && (b?.seq !== seq || b?.epoch !== epoch || b?.commentsSeq !== r.comments.sequence()))
                        return json(409, { code: 'file_changed', message: 'The Cloud file changed during verification' });
                    this.db.sql.exec("UPDATE files SET state='live' WHERE id=?", file);
                    r.leases.clear();
                    return json(200, { ok: true });
                } finally { this.activeImports.delete(file); }
            }
            if (blobBatch) {
                const b = await body();
                if (this.row(file, me).state === 'trash') return json(404, { code: 'not_found' });
                return this.sendBlobBatch(res, r, me, b?.hashes);
            }
            if (sub === 'manifest' && method === 'GET') {
                if (!whiteboard && r.core.hasWhiteboard()) return json(426, WHITEBOARD_UPDATE);
                await buildSnapshot(r.core);
                if (!whiteboard && r.core.hasWhiteboard()) return json(426, WHITEBOARD_UPDATE);
                const seq = url.searchParams.get('seq');
                const s = r.store.sql.exec<{
                    manifest: string;
                }>(seq ? 'SELECT manifest FROM snapshots WHERE seq=? AND state=\'done\'' : "SELECT manifest FROM snapshots WHERE state='done' ORDER BY seq DESC LIMIT 1", ...(seq ? [Number(seq)] : [])).toArray()[0];
                if (s && !whiteboard && supportsWhiteboard(JSON.parse(s.manifest).capabilities)) return json(426, WHITEBOARD_UPDATE);
                return json(s ? 200 : 404, s ? JSON.parse(s.manifest) : { code: 'not_found' });
            }
            if (sub === 'sync' && method === 'POST') {
                const b = await body(), fresh = this.current(me);
                if (!fresh)
                    return json(401, { code: 'removed' });
                if (this.row(file, fresh).state === 'trash') return json(404, { code: 'not_found' });
                r.roles.push(me.id, fresh.role);
                if (b.type === 'hello') {
                    if (!this.bank.grant(fresh.id, 'messages', 1, this.now())) error(429, 'quota', 'Message quota');
                    if (b.protocol !== 2)
                        return json(426, { code: 'update', message: 'Update Canvas' });
                    await buildSnapshot(r.core);
                    return json(200, { messages: r.core.hello(this.conn(fresh), b) });
                }
                this.edit(fresh);
                if (!whiteboard && r.core.hasWhiteboard()) return json(426, WHITEBOARD_UPDATE);
                const out = this.bounded(r, () => r.core.submit({ ...this.conn(fresh), whiteboard }, b));
                if (out.applied.length) {
                    this.broadcastActions(r, out.applied);
                    this.changed(r);
                }
                return json(200, { messages: [...(out.applied.length ? [{ type: 'applied', actions: out.applied }] : []), ...out.replies] });
            }
            if (importUpload) {
                if (!batchImport || row.created_by !== me.id) return json(403, { code: 'forbidden' });
                if (this.activeImports.has(file)) return json(409, { code: 'busy', message: 'Import is busy' });
                this.activeImports.add(file);
                activeImportUpload = file;
            }
            const uploadSub = importUpload ? sub.slice('import/'.length) : sub;
            if (uploadSub === 'uploads' && method === 'POST') {
                this.capacity(0);
                if (this.disk() < 5 * GB)
                    return json(507, { code: 'quota', message: 'Less than 5 GB free disk' });
                const b = await body();
                this.edit(me);
                this.capacity(b.bytes);
                if (importUpload) this.transferQuota(me, 'blobs', 1);
                const id = randomUUID();
                reserveUpload(r.core, this.ledger, this.conn(me), { ...b, id });
                return json(201, { id });
            }
            const part = /^uploads\/([a-z0-9-]+)\/parts\/(\d+)$/.exec(uploadSub);
            if (part && method === 'PUT') {
                const up = r.store.sql.exec<{
                    bytes: number;
                    by_id: string;
                    state: string;
                }>('SELECT bytes,by_id,state FROM uploads WHERE id=?', part[1]).toArray()[0];
                if (!up || up.by_id !== me.id || up.state !== 'open' || Number(part[2]) > 2047)
                    return json(404, { code: 'not_found' });
                const dir = path.join(this.root, 'uploads', file, part[1]);
                fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
                const dest = path.join(dir, part[2]), tmp = dest + '.tmp';
                if (fs.existsSync(dest) || fs.existsSync(tmp)) return json(409, { code: 'conflict' });
                if (!this.partBytes.has(dir)) this.partBytes.set(dir, diskBytes(dir));
                const declared = Number(req.headers['content-length']);
                if (importUpload && (!Number.isSafeInteger(declared) || declared <= 0 || declared > TRANSFER_PART_BYTES))
                    return json(413, { code: 'quota', message: 'Invalid import part length' });
                const meter = importUpload ? this.meterTransferInput(me, declared) : undefined;
                const limit = importUpload ? declared : 50 * 1024 * 1024;
                let bytes = 0;
                let fd: number | undefined, saved = false;
                try {
                    fd = fs.openSync(tmp, 'wx', 0o600);
                    this.activeParts.add(tmp);
                    for await (const c of req) {
                        meter?.add(c.length);
                        this.edit(me);
                        if (bytes + c.length > limit || this.partBytes.get(dir)! + c.length > up.bytes)
                            error(413, 'quota', 'Part exceeds its reservation');
                        this.capacity(c.length);
                        fs.writeSync(fd, c);
                        bytes += c.length; this.partBytes.set(dir, this.partBytes.get(dir)! + c.length);
                        this.usedBytes += c.length;
                    }
                    if (importUpload && bytes !== declared) error(400, 'invalid', 'Import part is incomplete');
                    fs.fsyncSync(fd);
                    this.edit(me);
                    if (fs.existsSync(dest)) return json(409, { code: 'conflict' });
                    fs.renameSync(tmp, dest);
                    saved = true;
                    return json(200, { bytes });
                } finally {
                    try {
                        if (fd !== undefined) {
                            this.activeParts.delete(tmp);
                            fs.closeSync(fd);
                            if (!saved) {
                                fs.rmSync(tmp, { force: true });
                                this.partBytes.set(dir, this.partBytes.get(dir)! - bytes);
                                this.usedBytes -= bytes;
                            }
                        }
                    } finally { meter?.release(); }
                }
            }
            const complete = /^uploads\/([a-z0-9-]+)\/complete$/.exec(uploadSub);
            if (complete && method === 'POST') {
                const up = r.store.sql.exec<{
                    bytes: number;
                    by_id: string;
                }>('SELECT bytes,by_id FROM uploads WHERE id=?', complete[1]).toArray()[0];
                if (!up || up.by_id !== me.id)
                    return json(404, { code: 'not_found' });
                const dir = path.join(this.root, 'uploads', file, complete[1]);
                const parts = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => /^\d+$/.test(n)).sort((a, b) => Number(a) - Number(b)) : [];
                if (!parts.length || parts.some((p, i) => Number(p) !== i) || parts.reduce((n, p) => n + fs.statSync(path.join(dir, p)).size, 0) !== up.bytes)
                    return json(400, { code: 'invalid', message: 'Upload parts are incomplete' });
                if (this.bodies >= 4 || this.inFlight + up.bytes > 256 * 1024 * 1024)
                    return json(503, { code: 'quota' });
                this.bodies++;
                this.inFlight += up.bytes;
                try {
                    this.edit(me);
                    const bytes = Buffer.concat(parts.map(p => fs.readFileSync(path.join(dir, p))));
                    const out = await putUpload(r.core, this.ledger, this.conn(me), complete[1], bytes);
                    this.removeParts(dir);
                    return json(200, out);
                }
                finally {
                    this.bodies--;
                    this.inFlight -= up.bytes;
                }
            }
            const copy = /^blobs\/([0-9a-f]{64})\/copy$/.exec(sub);
            if (copy && method === 'POST') {
                const b = await body();
                this.edit(me);
                const source = this.row(b.from, me);
                if (source.state !== 'live')
                    return json(404, { code: 'not_found' });
                const from = this.room(b.from);
                const blob = from.store.sql.exec<{
                    bytes: number;
                    type: string;
                }>('SELECT bytes,type FROM blobs WHERE sha256=? LIMIT 1', copy[1]).toArray()[0];
                if (!blob)
                    return json(404, { code: 'not_found' });
                if(this.bodies>=4||this.inFlight+blob.bytes>256*1024*1024)return json(503,{code:'quota'});
                this.bodies++;this.inFlight+=blob.bytes;
                try {
                  const bytes=await this.objects.get(blobKey(b.from,copy[1]));if(!bytes)return json(404,{code:'not_found'});
                  this.edit(me);this.capacity(blob.bytes);const id=randomUUID();reserveUpload(r.core,this.ledger,this.conn(me),{id,sha256:copy[1],...blob});
                  return json(200,await putUpload(r.core,this.ledger,this.conn(me),id,bytes));
                }finally{this.bodies--;this.inFlight-=blob.bytes;}
            }
            const upload = /^uploads\/([a-z0-9-]+)$/.exec(sub);
            if (upload && method === 'PUT') {
                const expected = r.store.sql.exec<{
                    bytes: number;
                }>('SELECT bytes FROM uploads WHERE id=?', upload[1]).toArray()[0];
                if (!expected)
                    return json(404, { code: 'not_found' });
                if (this.bodies >= 4 || this.inFlight + expected.bytes > 256 * 1024 * 1024)
                    return json(503, { code: 'quota', message: 'Uploads are busy; try again' });
                this.bodies++;
                this.inFlight += expected.bytes;
                try {
                    const chunks: Buffer[] = [];
                    let bytes = 0;
                    for await (const c of req) {
                        this.edit(me);
                        bytes += c.length;
                        if (bytes > expected.bytes)
                            error(413, 'quota', 'Upload is too large');
                        chunks.push(c);
                    }
                    this.edit(me);
                    const out = await putUpload(r.core, this.ledger, this.conn(me), upload[1], Buffer.concat(chunks));
                    return json(200, out);
                }
                finally {
                    this.bodies--;
                    this.inFlight -= expected.bytes;
                }
            }
            const obj = /^(boards|vers|blobs)\/([0-9a-f]{64})$/.exec(sub);
            if (obj && method === 'GET') {
                const sha = obj[2];
                let type = 'application/gzip', key = '';
                if (obj[1] === 'blobs') {
                    const b = r.store.sql.exec<{
                        type: string;
                    }>('SELECT type FROM blobs WHERE sha256=? LIMIT 1', sha).toArray()[0];
                    if (!b)
                        return json(404, { code: 'not_found' });
                    type = b.type;
                    key = blobKey(file, sha);
                }
                else {
                    const allowed = r.store.sql.exec<{
                        manifest: string;
                    }>("SELECT manifest FROM snapshots WHERE state='done'").toArray().some(s => { const a = JSON.parse(s.manifest) as Manifest; return obj[1] === 'boards' ? a.boards.some(b => b.sha256 === sha) : a.vers.sha256 === sha; });
                    if (!allowed)
                        return json(404, { code: 'not_found' });
                    key = obj[1] === 'boards' ? boardKey(file, sha) : versKey(file, sha);
                }
                const object=this.objects.diskFile(key);if(!object)return json(404,{code:'not_found'});
                const size=object.bytes;
                const headers:Record<string,string>={'content-type':type,'x-content-type-options':'nosniff','content-security-policy':"sandbox; default-src 'none'",'content-disposition':'attachment','cross-origin-resource-policy':'same-origin','cache-control':'private, max-age=31536000, immutable','accept-ranges':'bytes'};
                const range=/^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range??''));
                const start=range?Number(range[1]):0,end=range&&range[2]?Number(range[2]):size-1;
                if(start>end||end>=size){res.writeHead(416,{'content-range':`bytes */${size}`});res.end();return true;}
                if(range)headers['content-range']=`bytes ${start}-${end}/${size}`;
                headers['content-length']=String(end-start+1);res.writeHead(range?206:200,headers);
                const stream=fs.createReadStream(object.file,{start,end});this.downloads.set(res,me);res.on('finish',()=>this.downloads.delete(res));res.on('close',()=>{this.downloads.delete(res);stream.destroy();});stream.on('error',()=>res.destroy());stream.pipe(res);return true;
            }
            const voting = supportsPrivateVoteViews(String(req.headers[FILE_CAPABILITIES_HEADER] ?? '').split(/\s*,\s*/));
            if (sub === 'comments' && method === 'POST') {
                const b = await body(), fresh = this.current(me);
                if (!fresh) return json(403, { code: 'forbidden' });
                const state = this.row(file, fresh).state;
                if (state === 'trash') return json(404, { code: 'not_found' });
                if (!Array.isArray(b.ops) || b.ops.length > LIMITS.opsPerMessage)
                    return json(400, { code: 'invalid' });
                const importing = state === 'importing';
                const now = this.now();
                const allowance = importing ? this.importBank.grant('import:' + fresh.id, 'ops', b.ops.length, now)
                    : this.bank.grant(fresh.id, 'ops', b.ops.length, now);
                const out = this.submitComments(r, b.ops, fresh, allowance, voting);
                this.scheduleVoteExpiry(r);
                if (out.entries.length)
                    this.broadcastComments(r, out.entries);
                return json(200, { ...out, ...(allowance < b.ops.length && { retryAfterMs: 60_000 - now % 60_000 + 50 }), ...r.comments.snapshot(), ...(voting && r.comments.socialView(fresh)) });
            }
            if (sub === 'comments' && method === 'GET')
                return json(200, { ...r.comments.read(Number(url.searchParams.get('since') ?? 0)), ...(voting && r.comments.socialView(me)) });
            return json(404, { code: 'not_found' });
        }
        catch (e) {
            const x = e as any;
            return json(x.status ?? (x instanceof UploadError ? x.code === 'forbidden' ? 403 : x.code === 'quota' ? 429 : 400 : 500), { code: x.code ?? 'server', message: x.message });
        }
        finally {
            if (activeImportUpload) this.activeImports.delete(activeImportUpload);
            this.accountDatabase(path.join(this.root, 'team.sqlite'));
            if (touched) this.accountDatabase(path.join(this.root, 'files', touched + '.sqlite'));
        }
    }
    upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL, me: Me): boolean {
        const m = /^\/v1\/files\/([^/]+)\/socket$/.exec(url.pathname);
        if (!m)
            return false;
        try {
            if (!this.bank.grant(me.id, 'messages', 1, this.now())) error(429, 'quota', 'Message quota');
            const row = this.row(m[1], me);
            if (row.state === 'trash' || (row.state === 'importing' && this.db.sql.exec('SELECT 1 FROM file_transfer_imports WHERE file=?', row.id).toArray().length))
                error(404, 'not_found', 'No visible file');
            const r = this.room(m[1]);
            if ([...r.sockets.values()].filter(s => s.id === me.id).length >= 5 || [...this.rooms.values()].reduce((n, x) => n + x.sockets.size, 0) >= 256)
                error(429, 'quota', 'Socket limit');
            upgrade(req, socket, head, { maxMessage: 1024 * 1024, maxFragments: 1024 }, ws => {
                r.sockets.set(ws, me);
                const presence = { socket: { session: randomUUID(), person: me.id, author: { id: me.id, name: me.name }, role: me.role }, kept: {} as KeptPresence };
                r.presence.set(ws, presence);
                ws.on('close', () => {
                    r.sockets.delete(ws); r.ready.delete(ws); r.presence.delete(ws);
                    this.relayPresence(r, presence.socket, goneOf(presence.socket));
                });
                let chain = Promise.resolve(), window = this.now(), count = 0, queued = 0;
                ws.on('message', (text: string) => {
                    this.meter.message();
                    let parsed: any;
                    try { parsed = JSON.parse(text); } catch { ws.close(1008, 'Invalid JSON'); return; }
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { ws.close(1008, 'Invalid message'); return; }
                    if (parsed.type === 'presence') {
                        if (r.privateVoting) return;
                        const fresh = this.current(me);
                        if (!fresh) { ws.send(JSON.stringify({ type: 'removed' })); ws.close(1008, 'removed'); return; }
                        presence.socket.role = fresh.role;
                        const out = receivePresence(text, presence.socket, presence.kept, { limiter: this.presenceLimiter, now: this.now() });
                        if (out.ok) { presence.kept = out.kept; if (out.relay) this.relayPresence(r, presence.socket, out.relay); }
                        return;
                    }
                    if (this.now() - window >= 60000) {
                        window = this.now();
                        count = 0;
                    }
                    if (++count > 60 || queued >= 8) {
                        ws.close(1008, 'Message quota exceeded');
                        return;
                    }
                    queued++;
                    chain = chain.then(async () => {
                        const fresh = this.current(me);
                        if (!fresh) {
                            ws.send(JSON.stringify({ type: 'removed' }));
                            ws.close(1008, 'removed');
                            return;
                        }
                        if (this.row(m[1], fresh).state === 'trash') {
                            ws.close(1008, 'File is in Trash');
                            return;
                        }
                        r.roles.push(me.id, fresh.role);
                        const msg = parsed as FileClientMessage | any;
                        if (msg.type === 'hello') {
                            if (!this.bank.grant(fresh.id, 'messages', 1, this.now())) error(429, 'quota', 'Message quota');
                            if (msg.protocol !== 2) {
                                ws.send(JSON.stringify({ type: 'error', code: 'invalid', message: 'Update Canvas' }));
                                ws.close(1008, 'Update Canvas');
                                return;
                            }
                            await buildSnapshot(r.core);
                            if (!r.sockets.has(ws)) return;
                            const replies = r.core.hello(this.conn(fresh), msg);
                            for (const out of replies) ws.send(JSON.stringify(out));
                            if (!replies.some(out => out.type === 'welcome')) {
                                r.ready.delete(ws);
                                const failure = replies.find(out => out.type === 'error');
                                if (failure?.code === 'update') ws.close(1008, failure.message);
                                return;
                            }
                            r.ready.delete(ws);
                            const social = r.comments.snapshot();
                            r.ready.set(ws, supportsWhiteboard(msg.capabilities));
                            this.votingSockets.delete(ws);
                            const voting = supportsPrivateVoteViews(msg.capabilities);
                            if (voting) this.votingSockets.add(ws);
                            const peers = r.privateVoting ? [] : snapshotFor(presence.socket, r.presence.values());
                            if (peers.length) ws.send(JSON.stringify({ type: 'presence', peers }));
                            ws.send(JSON.stringify({ type: 'comments.snapshot', ...social, ...(voting && r.comments.socialView(fresh)) }));
                        }
                        else if (msg.type === 'actions' && r.ready.has(ws)) {
                            const out = this.bounded(r, () => r.core.submit({ ...this.conn(fresh), whiteboard: r.ready.get(ws) }, msg, Buffer.byteLength(text)));
                            if (out.applied.length) {
                                this.broadcastActions(r, out.applied);
                                this.changed(r);
                            }
                            for (const reply of out.replies)
                                ws.send(JSON.stringify(reply));
                        }
                        else if (msg.type === 'comments' && r.ready.has(ws) && Array.isArray(msg.ops) && msg.ops.length <= LIMITS.opsPerMessage) {
                            if (!this.bank.grant(fresh.id, 'messages', 1, this.now()))
                                error(429, 'quota', 'Message quota');
                            const allowance = this.bank.grant(fresh.id, 'ops', msg.ops.length, this.now());
                            const out = this.submitComments(r, msg.ops, fresh, allowance, this.votingSockets.has(ws));
                            this.scheduleVoteExpiry(r);
                            if (out.entries.length)
                                this.broadcastComments(r, out.entries);
                            ws.send(JSON.stringify({ type: 'comments.ack', acks: out.acks, rejected: out.rejected }));
                        }
                    }).catch((e) => ws.send(JSON.stringify({ type: 'error', code: e.code === 'quota' ? 'quota' : 'invalid', message: e.code === 'quota' ? 'Cloud storage cap reached' : 'Invalid file message' }))).finally(() => { queued--; });
                });
            });
        }
        catch (e) {
            socket.end(`HTTP/1.1 ${(e as any).status ?? 500} Refused\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        }
        return true;
    }
    close() {
        clearInterval(this.sweepTimer);
        for(const res of this.downloads.keys())res.destroy();this.downloads.clear(); for (const r of this.rooms.values()) {
        if (r.timer)
            clearTimeout(r.timer);
        for (const ws of r.sockets.keys())
            ws.terminate();
        clearTimeout(r.voteTimer);
        r.store.close();
    } this.rooms.clear(); }
}
