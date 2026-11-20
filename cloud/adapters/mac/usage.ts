import type { SqliteStore } from './sqlite.ts';
const GB = 1024 ** 3;
export function macUsageTone(free: number, stored: number, restarts: number): 'normal' | 'amber' | 'red' {
    return free < 5*GB || restarts > 3 ? 'red' : free < 20*GB || stored > 20*GB ? 'amber' : 'normal';
}
/** Minute buckets bound memory and preserve the last day's counts across host restarts. */
export class MacUsage {
    private started: number;
    private db: SqliteStore;
    private now: () => number;
    constructor(db: SqliteStore, now = Date.now) {
        this.db = db; this.now = now;
        this.started = now();
        db.sql.exec('CREATE TABLE IF NOT EXISTS usage_messages(minute INTEGER PRIMARY KEY,n INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS usage_boots(at INTEGER NOT NULL)');
        db.sql.exec('INSERT INTO usage_boots VALUES(?)', this.started);
        this.prune();
    }
    private prune() {
        this.db.sql.exec('DELETE FROM usage_messages WHERE minute<=?', Math.floor(this.now()/60000)-1440);
        this.db.sql.exec('DELETE FROM usage_boots WHERE at<=?', this.now()-3600000);
    }
    message() {
        this.db.sql.exec('INSERT INTO usage_messages VALUES(?,1) ON CONFLICT(minute) DO UPDATE SET n=n+1', Math.floor(this.now()/60000));
    }
    read() {
        this.prune();
        return {
            uptimeMs: Math.max(0, this.now()-this.started),
            messages24h: Number(this.db.sql.exec('SELECT COALESCE(SUM(n),0) AS n FROM usage_messages').one().n),
            restartsHour: Math.max(0, Number(this.db.sql.exec('SELECT COUNT(*) AS n FROM usage_boots').one().n)-1),
        };
    }
}
