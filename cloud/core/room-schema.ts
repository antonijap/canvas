import type { SqlStore } from "./sql.ts";

/** One-time backfill plus transactional byte accounting for existing and new rooms. */
export function initializeRoom(storage: SqlStore): void {
  storage.transactionSync(() => {
    const sql = storage.sql;
    sql.exec(`CREATE TABLE IF NOT EXISTS ops (
      seq INTEGER PRIMARY KEY, op_id TEXT UNIQUE NOT NULL, by_email TEXT NOT NULL,
      by_name TEXT NOT NULL, at TEXT NOT NULL, op_json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS threads (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS comment_threads (comment_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS op_receipts (op_id TEXT PRIMARY KEY, seq INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS room_timer (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_votes (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS room_vote_timers ON room_votes(json_extract(json, '$.timer.endsAt')) WHERE json_extract(json, '$.state') = 'active';
      CREATE TABLE IF NOT EXISTS room_vote_key (id INTEGER PRIMARY KEY CHECK (id = 1), key TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_vote_design (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vote_designs (id TEXT PRIMARY KEY, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS room_usage (id INTEGER PRIMARY KEY CHECK (id = 1), bytes INTEGER NOT NULL)`);
    if (!sql.exec("SELECT 1 FROM room_usage WHERE id = 1").toArray().length) {
      sql.exec(`INSERT OR IGNORE INTO op_receipts SELECT op_id, seq FROM ops;
        INSERT INTO comment_threads (comment_id, thread_id)
        SELECT json_extract(c.value, '$.id'), t.id FROM threads t, json_each(t.json, '$.comments') c;
        INSERT INTO room_usage SELECT 1,
          (SELECT COALESCE(SUM(length(CAST(json AS BLOB))), 0) FROM threads) +
          (SELECT COALESCE(SUM(length(CAST(op_json AS BLOB))), 0) FROM ops) +
          (SELECT COALESCE(SUM(length(CAST(op_id AS BLOB)) + 8), 0) FROM op_receipts)`);
    }
    sql.exec(`CREATE TRIGGER IF NOT EXISTS ops_receipt_insert AFTER INSERT ON ops BEGIN
        INSERT INTO op_receipts (op_id, seq) VALUES (new.op_id, new.seq); END;
      CREATE TRIGGER IF NOT EXISTS receipt_bytes_insert AFTER INSERT ON op_receipts BEGIN
        UPDATE room_usage SET bytes = bytes + length(CAST(new.op_id AS BLOB)) + 8 WHERE id = 1; END`);
    for (const [table, column] of [["threads", "json"], ["ops", "op_json"], ["room_votes", "json"], ["room_timer", "json"]]) {
      sql.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_bytes_insert AFTER INSERT ON ${table} BEGIN
          UPDATE room_usage SET bytes = bytes + length(CAST(new.${column} AS BLOB)) WHERE id = 1; END;
        CREATE TRIGGER IF NOT EXISTS ${table}_bytes_update AFTER UPDATE ON ${table} BEGIN
          UPDATE room_usage SET bytes = bytes + length(CAST(new.${column} AS BLOB)) - length(CAST(old.${column} AS BLOB)) WHERE id = 1; END;
        CREATE TRIGGER IF NOT EXISTS ${table}_bytes_delete AFTER DELETE ON ${table} BEGIN
          UPDATE room_usage SET bytes = bytes - length(CAST(old.${column} AS BLOB)) WHERE id = 1; END`);
    }
    sql.exec("DELETE FROM ops WHERE seq < (SELECT COALESCE(MAX(seq), 0) - 9999 FROM ops)");
  });
}
