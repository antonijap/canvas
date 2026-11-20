import { DocTree } from "./cloud-files-tree.ts";
// state.sqlite is the commit point. Package JSON is disposable and rebuilt from confirmed + pending.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Replica, type ReplicaDurable } from '../cloud/core/files/replica.ts';
import { materialize, type FileState } from '../cloud/core/files/state.ts';
import { applyAction, isReject } from '../cloud/core/files/apply.ts';
import { actionSha, type Action, type Author, type FileOp, type FileServerMessage, type Role } from '../cloud/protocol-files.ts';
import type { ObjectStore } from '../cloud/core/files/objects.ts';
export interface FileMeta {
    cloud: string;
    file: string;
    name: string;
    role: Role;
    author: Author;
    state: FileState;
}
export class FileStateStore {
    readonly db: DatabaseSync;
    readonly pkg: string;
    replica: Replica;
    meta: Omit<FileMeta, 'state'>;
    constructor(pkg: string, initial?: FileMeta) {
        this.pkg = pkg;
        fs.mkdirSync(path.join(pkg, '.cloud'), { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(path.join(pkg, '.cloud', 'state.sqlite'));
        this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS meta(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL, seq INTEGER NOT NULL, epoch INTEGER NOT NULL, view_tag INTEGER NOT NULL DEFAULT 0, view_hash TEXT);
      CREATE TABLE IF NOT EXISTS confirmed(first INTEGER PRIMARY KEY, last INTEGER NOT NULL, action_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pending(n INTEGER PRIMARY KEY, id TEXT UNIQUE, state TEXT NOT NULL, sha TEXT, action_json TEXT, history_json TEXT, code TEXT, message TEXT);
      CREATE TABLE IF NOT EXISTS last_writer(target TEXT PRIMARY KEY, action TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS checkpoint(id INTEGER PRIMARY KEY CHECK(id=1), json TEXT NOT NULL)`);
        const saved = this.db.prepare('SELECT json FROM checkpoint WHERE id=1').get() as {
            json: string;
        } | undefined;
        if (saved) {
            this.meta = JSON.parse(String(this.db.prepare('SELECT json FROM meta WHERE id=1').get()!.json));
            this.replica = Replica.restore(this.meta.author, JSON.parse(saved.json), { tree: DocTree.fromState });
        }
        else {
            if (!initial) {
                this.db.close();
                throw new Error('Cloud file has no durable state');
            }
            const { state, ...meta } = initial;
            this.meta = meta;
            this.replica = new Replica(meta.author, state, 0, 1, { tree: DocTree.fromState });
            this.commit();
        }
    }
    commit(actions: Extract<FileServerMessage, {
        type: 'applied';
    }>['actions'] = []): void {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const r = this.replica;
            this.db.prepare(`INSERT INTO meta(id,json,seq,epoch,view_tag) VALUES(1,?,?,?,1) ON CONFLICT(id) DO UPDATE SET json=excluded.json,seq=excluded.seq,epoch=excluded.epoch,view_tag=view_tag+1,view_hash=NULL`).run(JSON.stringify(this.meta), r.seq, r.epoch);
            for (const a of actions)
                this.db.prepare('INSERT OR IGNORE INTO confirmed VALUES(?,?,?)').run(a.first, a.last, JSON.stringify(a));
            this.db.exec('DELETE FROM pending; DELETE FROM last_writer');
            const pending = this.db.prepare('INSERT INTO pending(id,state,sha,action_json,code,message) VALUES(?,?,?,?,?,?)');
            for (const p of r.pending)
                pending.run(p.action.id, p.sent ? 'sent' : 'queued', p.sha, JSON.stringify(p.action), null, null);
            for (const p of r.refused)
                pending.run(p.action.id, 'refused', actionSha(p.action), JSON.stringify(p.action), p.code, p.message);
            const writer = this.db.prepare('INSERT INTO last_writer VALUES(?,?)');
            for (const [k, v] of Object.entries(r.tree.allVers()))
                writer.run(k, v);
            this.db.prepare('INSERT OR REPLACE INTO checkpoint VALUES(1,?)').run(JSON.stringify(r.durable()));
            // The durable checkpoint covers confirmed actions. Keeping only the latest 2,000 bounds recovery metadata.
            this.db.prepare('DELETE FROM confirmed WHERE first < COALESCE((SELECT first FROM confirmed ORDER BY first DESC LIMIT 1 OFFSET 1999),0)').run();
            this.db.exec('COMMIT');
        }
        catch (e) {
            this.db.exec('ROLLBACK');
            throw e;
        }
    }
    propose(ops: FileOp[], original?: Action) {
        if (this.meta.role !== 'owner' && this.meta.role !== 'editor')
            throw Object.assign(new Error('This Cloud file is read only'), { status: 403, code: 'read_only' });
        const before = this.replica.durable();
        const a = this.replica.propose(ops);
        if ('reject' in a) {
            if (a.reject === 'conflict') {
                const target = /^(\S+) was changed/.exec(a.message)?.[1];
                const writer = target ? this.replica.tree.ver(target) : null;
                const row = writer ? this.db.prepare("SELECT action_json FROM confirmed WHERE json_extract(action_json,'$.id')=? LIMIT 1").get(writer) : null;
                if (row) {
                    const action = JSON.parse(String(row.action_json));
                    const key = target!.split(':').at(-1);
                    a.message = (action.by.name ?? 'Someone') + ' changed ' + key + ' since';
                }
            }
            return a;
        }
        if (original) {
            a.id = original.id;
            if (original.agent)
                a.agent = original.agent;
            const p = this.replica.pending.at(-1)!;
            p.sha = actionSha(a);
        }
        try {
            this.commit();
        }
        catch (e) {
            this.replica = Replica.restore(this.meta.author, before, { tree: DocTree.fromState });
            throw e;
        }
        return a;
    }
    async receive(msg: FileServerMessage, objects: ObjectStore) {
        const before = this.replica.durable(), meta = { ...this.meta };
        try {
            if (msg.type === 'welcome') {
                this.meta.role = msg.role;
                this.meta.author = msg.me;
            }
            // joined is transport state, deliberately not restored after a process restart.
            const result = await this.replica.receive(msg, objects);
            this.commit(msg.type === 'applied' ? msg.actions : []);
            return result;
        }
        catch (e) {
            this.meta = meta;
            this.replica = Replica.restore(meta.author, before, { tree: DocTree.fromState });
            throw e;
        }
    }
    materialize(): void {
        const view = materialize(this.replica.view());
        for (const [name, bytes] of [['document.json', view.document], ['widgets.json', view.widgets]]) {
            const dest = path.join(this.pkg, name), tmp = dest + '.view-tmp';
            const fd = fs.openSync(tmp, 'w', 0o600);
            try {
                fs.writeFileSync(fd, bytes);
                fs.fsyncSync(fd);
            }
            finally {
                fs.closeSync(fd);
            }
            fs.renameSync(tmp, dest);
        }
        const hash = createHash('sha256').update(view.document).update('\0').update(view.widgets).digest('hex');
        this.db.prepare('UPDATE meta SET view_hash=? WHERE id=1').run(hash);
    }
    close() { this.db.close(); }
}
