// Disk objects and file rooms for a Mac hosted Cloud. Identity is checked before touching a room or an object.
import fs from "node:fs";
import path from "node:path";
import type http from "node:http";
import type { Duplex } from "node:stream";
import { randomUUID } from "node:crypto";
import { SqliteStore } from "./sqlite.ts";
import { MacUsage, macUsageTone } from './usage.ts';
import { PresenceLimiter, receivePresence, snapshotFor, goneOf, fanOut, type PresenceSocket, type KeptPresence, type PeerPresence } from '../../core/presence.ts';
import { upgrade, type ServerSocket } from "./websocket.ts";
import { FileRoom, type Conn } from "../../core/files/room.ts";
import { RoleCache } from "../../core/files/access.ts";
import { LeaseBank, RoomLeases } from "../../core/files/leases.ts";
import { StorageLedger, reserveUpload, putUpload, UploadError } from "../../core/files/uploads.ts";
import { buildSnapshot, recoverSnapshots, compact, type Manifest } from "../../core/files/snapshots.ts";
import { collectGarbage } from "../../core/files/gc.ts";
import { stateFromFiles } from "../../core/files/state.ts";
import { type ObjectStore, boardKey, versKey, blobKey } from "../../core/files/objects.ts";
import { Operations } from "../../core/operations.ts";
import type { Me } from "./host.ts";
import type { FileClientMessage, Role } from "../../protocol-files.ts";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SHA = /^[0-9a-f]{64}$/;
const GB = 1024 ** 3;
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
    constructor(root: string, check?: (bytes: number) => void) { this.check = check; this.root = root; fs.mkdirSync(root, { recursive: true, mode: 0o700 }); }
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
    async delete(key: string) { fs.rmSync(this.at(key), { force: true }); }
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
interface Room {
    leases: RoomLeases;
    store: SqliteStore;
    core: FileRoom;
    comments: Operations;
    roles: RoleCache;
    sockets: Map<ServerSocket, Me>;
    presence: Map<ServerSocket, { socket: PresenceSocket; kept: KeptPresence }>;
    lastAction: number;
    snapshotAt: number;
    timer?: ReturnType<typeof setTimeout>;
}
export class MacFiles {
    readonly objects: DiskObjects;
    private readonly db: SqliteStore;
    private readonly root: string;
    private readonly rooms = new Map<string, Room>();
    private readonly presenceLimiter = new PresenceLimiter();
    private readonly downloads = new Map<http.ServerResponse, Me>();
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
    constructor(root: string, db: SqliteStore, current: (me: Me) => Me | null, role: (person: string) => Role | null, now = Date.now, cap = 20 * GB) {
        this.cap = cap;
        this.root = root;
        this.db = db;
        this.current = current;
        this.role = role;
        this.now = now;
        this.meter = new MacUsage(db, now);
        fs.mkdirSync(path.join(root, 'files'), { recursive: true, mode: 0o700 });
        this.objects = new DiskObjects(path.join(root, 'objects'), bytes => this.capacity(bytes));
        db.sql.exec(`CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,name TEXT NOT NULL,state TEXT NOT NULL,created_by TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)`);
        this.bank = new LeaseBank(db);
        this.importBank = new LeaseBank(db, { ops: 6000, messages: 120, presence: 0 });
        this.ledger = new StorageLedger(db, cap);
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
                    return importing && kind === 'ops' ? this.importBank.grant('cloud-import', kind, want, now) : this.bank.grant(person, kind, want, now);
                } }, this.now);
            const core = new FileRoom({ store, file, objects: this.objects, roles, leases, now: this.now });
            recoverSnapshots(core);
            const comments = new Operations(store);
            if (!store.sql.exec("SELECT 1 AS one FROM pragma_table_info('ops') WHERE name = 'by_id'").toArray().length)
                store.sql.exec('ALTER TABLE ops ADD COLUMN by_id TEXT');
            r = { leases, store, core, roles, comments, sockets: new Map(), presence: new Map(), lastAction: 0, snapshotAt: this.now() };
            this.rooms.set(file, r);
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
    private broadcast(r: Room, msg: unknown) { this.recheck(); for (const ws of r.sockets.keys())
        ws.send(JSON.stringify(msg)); }
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
    }
    private changed(r: Room) {
        this.db.sql.exec('UPDATE files SET updated_at=? WHERE id=?', new Date(this.now()).toISOString(), r.core.file);
        r.lastAction++;
        if (r.timer)
            clearTimeout(r.timer);
        const take = async () => { await buildSnapshot(r.core); compact(r.core); await collectGarbage(r.core, this.ledger); r.lastAction = 0; r.snapshotAt = this.now(); };
        r.timer = setTimeout(() => void take().catch(() => { }), r.lastAction >= 2000 ? 0 : 300000);
        r.timer.unref();
    }
    private edit(me: Me) { const fresh = this.current(me); if (!fresh)
        error(401, 'removed', 'This device was removed'); if (fresh!.role !== 'owner' && fresh!.role !== 'editor')
        error(403, 'read_only', 'This Cloud file is read only'); return fresh!; }
    private capacity(bytes: number) { if (diskBytes(this.root) + bytes > this.cap)
        error(429, 'quota', "This Cloud storage cap is reached"); }
    private disk() { const s = fs.statfsSync(this.root); return s.bavail * s.bsize; }
    private storage(): number { return fs.readdirSync(path.join(this.root, 'files')).reduce((n, f) => n + fs.statSync(path.join(this.root, 'files', f)).size, 0) + this.ledger.held(); }
    async route(req: http.IncomingMessage, res: http.ServerResponse, url: URL, me: Me, body: () => Promise<any>): Promise<boolean> {
        if (!(url.pathname === '/v1/usage' || url.pathname === '/v1/files' || url.pathname.startsWith('/v1/files/')))
            return false;
        const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(value)); return true; };
        try {
            const p = url.pathname, method = req.method ?? 'GET';
            this.meter.message();
            if (p === '/v1/usage') {
                if (me.role !== 'owner')
                    return json(403, { code: 'forbidden', message: 'Owner role required' });
                const freeDisk = this.disk(), storageBytes = diskBytes(this.root);
                const stats = this.meter.read();
                return json(200, { adapter: 'mac', storageBytes, freeDisk, peopleConnected: new Set([...this.rooms.values()].flatMap(r => [...r.sockets.values()].map(m => m.id))).size, ...stats, estimated: true, tone: macUsageTone(freeDisk, storageBytes, stats.restartsHour), brake: freeDisk < 5 * GB ? 'storage' : 'none' });
            }
            if (p === '/v1/files') {
                if (method === 'GET')
                    return json(200, { files: this.db.sql.exec<Row>("SELECT * FROM files WHERE state='live' ORDER BY updated_at DESC,id").toArray().filter(r => !url.searchParams.get('q') || r.name.toLowerCase().includes(url.searchParams.get('q')!.toLowerCase())), role: me.role });
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
                this.db.sql.exec("INSERT INTO files VALUES(?,?,?,?,?,?)", id, b.name, b.importing === true ? 'importing' : 'live', me.id, new Date(this.now()).toISOString(), new Date(this.now()).toISOString());
                const r = this.room(id);
                r.core.seedState(stateFromFiles({ version: typeof b.version === 'string' && /^2\.\d{1,3}$/.test(b.version) ? b.version : '2.21', children: [] }));
                await buildSnapshot(r.core);
                return json(201, { id, name: b.name });
            }
            const m = /^\/v1\/files\/([^/]+)(?:\/(.*))?$/.exec(p)!;
            const file = m[1], sub = m[2] ?? '', row = this.row(file, me);
            if (!['GET', 'HEAD'].includes(method) && sub !== 'sync' && sub !== 'comments')
                this.edit(me);
            if (row.state === 'trash')
                return json(404, { code: 'not_found', message: 'File is in Trash' });
            if (!sub && method === 'PATCH') {
                const b = await body();
                this.edit(me);
                if (typeof b.name !== 'string' || !b.name.trim() || b.name.length > 200)
                    return json(400, { code: 'invalid' });
                this.db.sql.exec('UPDATE files SET name=? WHERE id=?', b.name, file);
                return json(200, { ok: true });
            }
            if (!sub && method === 'DELETE') {
                if (me.role !== 'owner' && row.created_by !== me.id)
                    return json(403, { code: 'forbidden' });
                this.db.sql.exec("UPDATE files SET state='trash' WHERE id=?", file);
                const r = this.rooms.get(file);
                if (r)
                    for (const ws of r.sockets.keys())
                        ws.close(1008, 'File is in Trash');
                return json(200, { ok: true });
            }
            if (sub === 'import' && method === 'DELETE') {
                if(row.created_by !== me.id) return json(403,{code:'forbidden'});
                const r=this.rooms.get(file) ?? this.room(file);
                // A failed move must not discard somebody else's edits made after publication.
                if(r.store.sql.exec("SELECT 1 FROM log WHERE json_extract(by_json,'$.id')!=? LIMIT 1",me.id).toArray().length)
                    return json(409,{code:'conflict',message:'Another person edited the imported file; kept it in the Cloud'});
                if(r.timer)clearTimeout(r.timer);
                for(const ws of r.sockets.keys())ws.close(1008,'Import cancelled');
                r.presence.clear();r.sockets.clear();r.store.close();this.rooms.delete(file);
                for(const suffix of ['', '-wal','-shm'])fs.rmSync(path.join(this.root,'files',file+'.sqlite'+suffix),{force:true});
                fs.rmSync(path.join(this.objects.root,'files',file),{recursive:true,force:true});
                this.db.sql.exec('DELETE FROM storage_held WHERE key LIKE ?',`${file}/%`);
                this.db.sql.exec('DELETE FROM files WHERE id=?',file);
                return json(200,{ok:true});
            }
            const r = this.room(file);
            if (sub === 'import' && method === 'POST') {
                if (row.created_by !== me.id)
                    return json(403, { code: 'forbidden' });
                this.db.sql.exec("UPDATE files SET state='importing' WHERE id=?", file);
                return json(200, { ok: true });
            }
            if (sub === 'import/complete' && method === 'POST') {
                if (row.created_by !== me.id)
                    return json(403, { code: 'forbidden' });
                await buildSnapshot(r.core);
                this.edit(me);
                this.db.sql.exec("UPDATE files SET state='live' WHERE id=?", file);
                r.leases.clear();
                return json(200, { ok: true });
            }
            if (sub === 'manifest' && method === 'GET') {
                await buildSnapshot(r.core);
                const seq = url.searchParams.get('seq');
                const s = r.store.sql.exec<{
                    manifest: string;
                }>(seq ? 'SELECT manifest FROM snapshots WHERE seq=? AND state=\'done\'' : "SELECT manifest FROM snapshots WHERE state='done' ORDER BY seq DESC LIMIT 1", ...(seq ? [Number(seq)] : [])).toArray()[0];
                return json(s ? 200 : 404, s ? JSON.parse(s.manifest) : { code: 'not_found' });
            }
            if (sub === 'sync' && method === 'POST') {
                const b = await body(), fresh = this.current(me);
                if (!fresh)
                    return json(401, { code: 'removed' });
                r.roles.push(me.id, fresh.role);
                if (b.type === 'hello') {
                    if (b.protocol !== 2)
                        return json(426, { code: 'update', message: 'Update Canvas' });
                    await buildSnapshot(r.core);
                    return json(200, { messages: r.core.hello(this.conn(fresh), b) });
                }
                this.edit(fresh);
                const out = this.bounded(r, () => r.core.submit(this.conn(fresh), b));
                if (out.applied.length) {
                    this.broadcast(r, { type: 'applied', actions: out.applied });
                    this.changed(r);
                }
                return json(200, { messages: [...(out.applied.length ? [{ type: 'applied', actions: out.applied }] : []), ...out.replies] });
            }
            if (sub === 'uploads' && method === 'POST') {
                this.capacity(0);
                if (this.disk() < 5 * GB)
                    return json(507, { code: 'quota', message: 'Less than 5 GB free disk' });
                const b = await body();
                this.edit(me);
                this.capacity(b.bytes);
                const id = randomUUID();
                reserveUpload(r.core, this.ledger, this.conn(me), { ...b, id });
                return json(201, { id });
            }
            const part = /^uploads\/([a-z0-9-]+)\/parts\/(\d+)$/.exec(sub);
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
                let bytes = 0;
                const fd = fs.openSync(tmp, 'wx', 0o600);
                try {
                    for await (const c of req) {
                        this.edit(me);
                        bytes += c.length;
                        if (bytes > 50 * 1024 * 1024 || bytes > up.bytes)
                            error(413, 'quota', 'Part exceeds its reservation');
                        this.capacity(c.length);
                        fs.writeSync(fd, c);
                    }
                    fs.fsyncSync(fd);
                }
                catch (e) {
                    fs.rmSync(tmp, { force: true });
                    throw e;
                }
                finally {
                    fs.closeSync(fd);
                }
                this.edit(me);
                if (fs.existsSync(dest)) {
                    fs.unlinkSync(tmp);
                    return json(409, { code: 'conflict' });
                }
                fs.renameSync(tmp, dest);
                return json(200, { bytes });
            }
            const complete = /^uploads\/([a-z0-9-]+)\/complete$/.exec(sub);
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
                    fs.rmSync(dir, { recursive: true, force: true });
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
            if (sub === 'comments' && method === 'POST') {
                const b = await body(), fresh = this.current(me);
                if (!fresh || fresh.role === 'viewer')
                    return json(403, { code: 'read_only' });
                if (!Array.isArray(b.ops) || b.ops.length > 100)
                    return json(400, { code: 'invalid' });
                const allowance = this.bank.grant(fresh.id, 'ops', b.ops.length, this.now());
                const out = this.bounded(r, () => r.comments.submit(file, b.ops, fresh, fresh.role, allowance));
                if (out.entries.length)
                    this.broadcast(r, { type: 'comments.applied', entries: out.entries });
                return json(200, { ...out, ...r.comments.snapshot() });
            }
            if (sub === 'comments' && method === 'GET')
                return json(200, r.comments.read(Number(url.searchParams.get('since') ?? 0)));
            return json(404, { code: 'not_found' });
        }
        catch (e) {
            const x = e as any;
            return json(x.status ?? (x instanceof UploadError ? x.code === 'forbidden' ? 403 : x.code === 'quota' ? 429 : 400 : 500), { code: x.code ?? 'server', message: x.message });
        }
    }
    upgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, url: URL, me: Me): boolean {
        const m = /^\/v1\/files\/([^/]+)\/socket$/.exec(url.pathname);
        if (!m)
            return false;
        try {
            const row = this.row(m[1], me);
            if (row.state === 'trash')
                error(404, 'not_found', 'File is in Trash');
            const r = this.room(m[1]);
            if ([...r.sockets.values()].filter(s => s.id === me.id).length >= 5 || [...this.rooms.values()].reduce((n, x) => n + x.sockets.size, 0) >= 256)
                error(429, 'quota', 'Socket limit');
            upgrade(req, socket, head, { maxMessage: 1024 * 1024, maxFragments: 1024 }, ws => {
                r.sockets.set(ws, me);
                const presence = { socket: { session: randomUUID(), person: me.id, author: { id: me.id, name: me.name }, role: me.role }, kept: {} as KeptPresence };
                r.presence.set(ws, presence);
                ws.on('close', () => {
                    r.sockets.delete(ws); r.presence.delete(ws);
                    this.relayPresence(r, presence.socket, goneOf(presence.socket));
                });
                let chain = Promise.resolve(), window = this.now(), count = 0, queued = 0;
                ws.on('message', (text: string) => {
                    this.meter.message();
                    let parsed: any;
                    try { parsed = JSON.parse(text); } catch { ws.close(1008, 'Invalid JSON'); return; }
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) { ws.close(1008, 'Invalid message'); return; }
                    if (parsed.type === 'presence') {
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
                        if (fresh)
                            this.row(m[1], fresh);
                        if (!fresh) {
                            ws.send(JSON.stringify({ type: 'removed' }));
                            ws.close(1008, 'removed');
                            return;
                        }
                        r.roles.push(me.id, fresh.role);
                        const msg = parsed as FileClientMessage | any;
                        if (msg.type === 'hello') {
                            if (msg.protocol !== 2) {
                                ws.send(JSON.stringify({ type: 'error', code: 'invalid', message: 'Update Canvas' }));
                                ws.close(1008, 'Update Canvas');
                                return;
                            }
                            await buildSnapshot(r.core);
                            for (const out of r.core.hello(this.conn(fresh), msg))
                                ws.send(JSON.stringify(out));
                            const peers = snapshotFor(presence.socket, r.presence.values());
                            if (peers.length) ws.send(JSON.stringify({ type: 'presence', peers }));
                            ws.send(JSON.stringify({ type: 'comments.snapshot', ...r.comments.snapshot() }));
                        }
                        else if (msg.type === 'actions') {
                            const out = this.bounded(r, () => r.core.submit(this.conn(fresh), msg, Buffer.byteLength(text)));
                            if (out.applied.length) {
                                this.broadcast(r, { type: 'applied', actions: out.applied });
                                this.changed(r);
                            }
                            for (const reply of out.replies)
                                ws.send(JSON.stringify(reply));
                        }
                        else if (msg.type === 'comments' && Array.isArray(msg.ops)) {
                            if (!this.bank.grant(fresh.id, 'messages', 1, this.now()))
                                error(429, 'quota', 'Message quota');
                            const allowance = this.bank.grant(fresh.id, 'ops', msg.ops.length, this.now());
                            const out = this.bounded(r, () => r.comments.submit(m[1], msg.ops, fresh, fresh.role, allowance));
                            if (out.entries.length)
                                this.broadcast(r, { type: 'comments.applied', entries: out.entries });
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
        for(const res of this.downloads.keys())res.destroy();this.downloads.clear(); for (const r of this.rooms.values()) {
        if (r.timer)
            clearTimeout(r.timer);
        for (const ws of r.sockets.keys())
            ws.terminate();
        r.store.close();
    } this.rooms.clear(); }
}
