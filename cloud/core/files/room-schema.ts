// A Cloud file room's rows: plain SQL that a Durable Object's SQLite and node:sqlite both run (no extensions, no
// FTS, no statements that open transactions; the caller wraps writes in transactionSync).
//
// nodes: one row per layer. `parent` is "" at the top level. `pos` orders siblings (positions.ts). `props` is the
// node's JSON in its key order with "children": null where its children list sits. `deleted_seq` marks the root of a
// removed subtree; a node is live when it and every ancestor have none. Compaction drops removed subtrees.
// refs: (component, user) for every live or removed node that names a component (its ref or one in its overrides).
// vers: the action that last wrote each target (n:<id>:<key>, t:<id>, d:<key>, w:<id>, p:<id>, po:<board>, m:<key>).
// kv: doc/variables, doc/themes, doc/fonts, pages, meta/<key>.
// log: applied actions since the oldest kept version; text_edits: what each one did to a text layer, for the
// splice transform. receipts outlive both (30 days) and bind an action id to its author, epoch and payload hash.

import type { SqlStore } from "../sql.ts";

export const FILE_ROOM_SCHEMA_VERSION = 1;

export const FILE_ROOM_DDL = `
CREATE TABLE IF NOT EXISTS file_meta (id INTEGER PRIMARY KEY CHECK (id = 1), file TEXT NOT NULL, schema INTEGER NOT NULL,
  epoch INTEGER NOT NULL, seq INTEGER NOT NULL, log_floor INTEGER NOT NULL, receipt_floor INTEGER NOT NULL,
  snapshot_seq INTEGER NOT NULL, node_bytes INTEGER NOT NULL DEFAULT 0, top_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS nodes (id TEXT PRIMARY KEY, parent TEXT NOT NULL, pos TEXT NOT NULL, type TEXT NOT NULL,
  props TEXT NOT NULL, deleted_seq INTEGER) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS nodes_whiteboard ON nodes(type) WHERE deleted_seq IS NULL AND type IN ('sticky', 'sticker');
CREATE INDEX IF NOT EXISTS nodes_children ON nodes(parent, pos);
CREATE INDEX IF NOT EXISTS nodes_deleted ON nodes(deleted_seq) WHERE deleted_seq IS NOT NULL;
CREATE TABLE IF NOT EXISTS refs (ref TEXT NOT NULL, user TEXT NOT NULL, PRIMARY KEY (ref, user)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS refs_user ON refs(user);
CREATE TABLE IF NOT EXISTS vers (target TEXT PRIMARY KEY, action TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, json TEXT NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS widgets (id TEXT PRIMARY KEY, pos TEXT NOT NULL, json TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS widgets_order ON widgets(pos);
CREATE TABLE IF NOT EXISTS blobs (path TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, type TEXT NOT NULL,
  added_seq INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS blobs_sha ON blobs(sha256);
CREATE TABLE IF NOT EXISTS log (first INTEGER PRIMARY KEY, last INTEGER NOT NULL, action TEXT NOT NULL, by_json TEXT NOT NULL,
  at TEXT NOT NULL, ops_json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS text_edits (node TEXT NOT NULL, seq INTEGER NOT NULL, action TEXT NOT NULL, whole INTEGER NOT NULL,
  from_ INTEGER NOT NULL, del INTEGER NOT NULL, ins INTEGER NOT NULL, PRIMARY KEY (node, seq)) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS text_edits_seq ON text_edits(seq);
CREATE TABLE IF NOT EXISTS receipts (action TEXT PRIMARY KEY, by_id TEXT NOT NULL, epoch INTEGER NOT NULL, sha TEXT NOT NULL,
  first INTEGER NOT NULL, last INTEGER NOT NULL, at_ms INTEGER NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS receipts_last ON receipts(last);
CREATE TABLE IF NOT EXISTS dirty_boards (board TEXT PRIMARY KEY) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS board_bytes (board TEXT PRIMARY KEY, bytes INTEGER NOT NULL) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS snapshots (seq INTEGER PRIMARY KEY, manifest TEXT NOT NULL, at_ms INTEGER NOT NULL, by_id TEXT,
  label TEXT, pinned INTEGER NOT NULL DEFAULT 0, bytes INTEGER NOT NULL, state TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS uploads (id TEXT PRIMARY KEY, sha256 TEXT NOT NULL, bytes INTEGER NOT NULL, type TEXT NOT NULL,
  by_id TEXT NOT NULL, at_ms INTEGER NOT NULL, state TEXT NOT NULL) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS uploads_sha ON uploads(sha256);
CREATE TABLE IF NOT EXISTS usage_days (day TEXT PRIMARY KEY, messages INTEGER NOT NULL DEFAULT 0, actions INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0, rows_read INTEGER NOT NULL DEFAULT 0, bytes_in INTEGER NOT NULL DEFAULT 0,
  awake_ms INTEGER NOT NULL DEFAULT 0) WITHOUT ROWID;
`;

/** Every table the room keeps, for tests that check a crash left nothing half written. */
export const FILE_ROOM_TABLES = ["file_meta", "nodes", "refs", "vers", "kv", "widgets", "blobs", "log", "text_edits", "receipts", "dirty_boards", "board_bytes", "snapshots", "uploads", "usage_days"] as const;

/** Create the tables (idempotent). The first open also writes the meta row for `file`. */
export function initFileRoomSchema(store: SqlStore, file: string): void {
  store.transactionSync(() => {
    store.sql.exec(FILE_ROOM_DDL);
    const have = store.sql.exec<{ file: string }>("SELECT file FROM file_meta WHERE id = 1").toArray();
    if (!have.length) {
      store.sql.exec("INSERT INTO file_meta (id, file, schema, epoch, seq, log_floor, receipt_floor, snapshot_seq, top_json) VALUES (1, ?, ?, 1, 0, 0, 0, 0, ?)", file, FILE_ROOM_SCHEMA_VERSION, "{}");
    } else if (have[0].file !== file) {
      throw new Error(`this room holds file ${have[0].file}, not ${file}`);
    }
  });
}
