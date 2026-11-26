// Snapshots, compaction and restore (Section 3). A snapshot is a manifest of board objects (each top level child as
// gzip JSON, named by the SHA-256 of that JSON) plus the rest of the file inline. Unchanged boards reuse their object.
//
// A build is three steps: (1) one transaction reads the state at seq S, takes the dirty boards and writes a
// `building` row whose draft manifest already names every object (so collection keeps them); (2) the objects are
// written, each only if absent; (3) one transaction marks the row `done`. A crash between leaves a `building` row:
// recoverSnapshots() marks its boards dirty again and drops it. Compaction trims the log, the text edits, old
// receipts and removed subtrees only below what a `done` snapshot covers.

import { checkBlobPath, safeBlobPath } from "../../protocol-files.ts";
import type { FileRoom } from "./room.ts";
import { RECEIPT_DAYS, DAY_MS } from "./room.ts";
import { stateOf, type FileState } from "./state.ts";
import { MemoryTree } from "./tree-memory.ts";
import { sha256Hex } from "./sha256.ts";
import { boardKey, versKey, manifestKey, gzipText, gunzipText, utf8, fromUtf8 } from "./objects.ts";
import { keptVersions } from "./versions.ts";
import type { BlobRow, DocNode, Json, PageRow } from "./seam.ts";
import type { FileServerMessage } from "./messages.ts";
import { WHITEBOARD } from "../../protocol-files.ts";

export interface Manifest {
  capabilities?: string[];
  format: 1;
  file: string;
  seq: number;
  epoch: number;
  top: Record<string, Json>;
  doc: FileState["doc"];
  boards: { id: string; sha256: string }[];
  widgets: Json[];
  pages: PageRow[] | null;
  meta: Record<string, Json>;
  blobs: { path: string; sha256: string; bytes: number; type: string }[];
  vers: { sha256: string };
}

type SnapRow = { seq: number; manifest: string; at_ms: number; pinned: number; state: string; label: string | null; by_id: string | null; bytes: number };

/** Build a snapshot of the room's current state. Returns its seq (an existing one at the same seq is reused). */
export function buildSnapshot(room: FileRoom, opts: { label?: string; by?: string; pinned?: boolean } = {}): Promise<number> {
  return room.exclusive(() => buildLocked(room, opts));
}

async function buildLocked(room: FileRoom, opts: { label?: string; by?: string; pinned?: boolean }): Promise<number> {
  const { store, tree, objects, file } = room;
  // Step 1: read at S, write the draft.
  const draft = store.transactionSync(() => {
    const m = room.meta();
    const have = store.sql.exec<SnapRow>("SELECT * FROM snapshots WHERE seq = ?", m.seq).toArray()[0];
    if (have && have.state === "done") {
      if (opts.pinned || opts.label) store.sql.exec("UPDATE snapshots SET pinned = MAX(pinned, ?), label = COALESCE(?, label), by_id = COALESCE(?, by_id) WHERE seq = ?", opts.pinned ? 1 : 0, opts.label ?? null, opts.by ?? null, m.seq);
      return null;
    }
    tree.forget();
    const prevRow = store.sql.exec<{ manifest: string }>("SELECT manifest FROM snapshots WHERE state = 'done' ORDER BY seq DESC LIMIT 1").toArray()[0];
    const parsed = prevRow ? (JSON.parse(prevRow.manifest) as Manifest) : null;
    // Objects of another epoch never stand in for boards of this one (a restore replaced every row).
    const prev = parsed && parsed.epoch === m.epoch ? parsed : null;
    const prevBoards = new Map(prev?.boards.map((b) => [b.id, b.sha256]) ?? []);
    const dirty = new Set(store.sql.exec<{ board: string }>("SELECT board FROM dirty_boards").toArray().map((r) => r.board));
    // Only boards that changed are read and written again; the rest keep their object.
    const state = stateOf(tree, false);
    const writes: { key: string; text: string }[] = [];
    const boards = tree.children(null).map((id) => {
      const reuse = prevBoards.get(id);
      if (reuse && !dirty.has(id)) return { id, sha256: reuse };
      const text = JSON.stringify(tree.subtree(id));
      const sha = sha256Hex(text);
      writes.push({ key: boardKey(file, sha), text });
      return { id, sha256: sha };
    });
    const versText = JSON.stringify(state.vers);
    const versSha = sha256Hex(versText);
    writes.push({ key: versKey(file, versSha), text: versText });
    const manifest: Manifest = {
      format: 1, file, seq: m.seq, epoch: m.epoch, top: state.top, doc: state.doc, boards, widgets: state.widgets, pages: state.pages, meta: state.meta,
      ...(room.hasWhiteboard() ? { capabilities: [WHITEBOARD] } : {}),
      blobs: Object.entries(state.blobs).map(([path, b]) => ({ path, ...b })), vers: { sha256: versSha },
    };
    const text = JSON.stringify(manifest);
    store.sql.exec("DELETE FROM snapshots WHERE seq = ?", m.seq);
    store.sql.exec("INSERT INTO snapshots (seq, manifest, at_ms, by_id, label, pinned, bytes, state) VALUES (?, ?, ?, ?, ?, ?, ?, 'building')", m.seq, text, room.now(), opts.by ?? null, opts.label ?? null, opts.pinned ? 1 : 0, text.length);
    store.sql.exec("DELETE FROM dirty_boards");
    room.flushUsage();
    return { seq: m.seq, text, writes };
  });
  if (!draft) return room.meta().seq;
  // Step 2: the objects.
  let bytes = draft.text.length;
  for (const w of draft.writes) {
    const gz = await gzipText(w.text);
    bytes += gz.length;
    await objects.putIfAbsent(w.key, gz);
  }
  await objects.putIfAbsent(manifestKey(file, draft.seq), utf8(draft.text));
  // Step 3: done.
  store.transactionSync(() => {
    store.sql.exec("UPDATE snapshots SET state = 'done', bytes = ? WHERE seq = ? AND state = 'building'", bytes, draft.seq);
    store.sql.exec("UPDATE file_meta SET snapshot_seq = MAX(snapshot_seq, ?) WHERE id = 1", draft.seq);
  });
  return draft.seq;
}

/** After a crash: every `building` row gives its boards back to the dirty list and goes. Call when a room starts. */
export function recoverSnapshots(room: FileRoom): number {
  return room.store.transactionSync(() => {
    const rows = room.store.sql.exec<{ seq: number; manifest: string }>("SELECT seq, manifest FROM snapshots WHERE state = 'building'").toArray();
    for (const r of rows) {
      const m = JSON.parse(r.manifest) as Manifest;
      for (const b of m.boards) room.store.sql.exec("INSERT OR IGNORE INTO dirty_boards (board) VALUES (?)", b.id);
      room.store.sql.exec("DELETE FROM snapshots WHERE seq = ?", r.seq);
    }
    return rows.length;
  });
}

/**
 * Drop what no kept version needs: versions past retention (versions.ts), log rows and text edits at or below the
 * oldest kept `done` snapshot, removed subtrees removed at or before it, and receipts older than RECEIPT_DAYS (which
 * raises the receipt floor). Never touches a `building` row.
 */
export function compact(room: FileRoom): { versionsDropped: number; logDropped: number; receiptsDropped: number; rowsPurged: number } {
  const { store, tree } = room;
  return store.transactionSync(() => {
    const now = room.now();
    const rows = store.sql.exec<SnapRow>("SELECT seq, at_ms, pinned, state FROM snapshots").toArray();
    const keep = keptVersions(rows.map((r) => ({ seq: r.seq, at: r.at_ms, pinned: !!r.pinned, state: r.state as "done" | "building" })), now);
    let versionsDropped = 0;
    for (const r of rows) if (!keep.has(r.seq)) {
      store.sql.exec("DELETE FROM snapshots WHERE seq = ?", r.seq);
      versionsDropped++;
    }
    const oldest = store.sql.exec<{ seq: number | null }>("SELECT MIN(seq) AS seq FROM snapshots WHERE state = 'done'").one().seq;
    let logDropped = 0, rowsPurged = 0;
    if (oldest !== null) {
      logDropped = store.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM log WHERE last <= ?", oldest).one().n;
      store.sql.exec("DELETE FROM log WHERE last <= ?", oldest);
      store.sql.exec("DELETE FROM text_edits WHERE seq <= ?", oldest);
      store.sql.exec("UPDATE file_meta SET log_floor = MAX(log_floor, ?) WHERE id = 1", oldest);
      tree.forget();
      tree.bytesDelta = 0;
      tree.boardDelta.clear();
      rowsPurged = tree.purgeRemoved(oldest);
      tree.flushBoardBytes();
      store.sql.exec("UPDATE file_meta SET node_bytes = MAX(0, node_bytes + ?) WHERE id = 1", tree.bytesDelta);
    }
    const cutoff = now - RECEIPT_DAYS * DAY_MS;
    const floor = store.sql.exec<{ x: number | null }>("SELECT MAX(last) AS x FROM receipts WHERE at_ms < ?", cutoff).one().x;
    let receiptsDropped = 0;
    if (floor !== null) {
      receiptsDropped = store.sql.exec<{ n: number }>("SELECT COUNT(*) AS n FROM receipts WHERE last <= ?", floor).one().n;
      store.sql.exec("DELETE FROM receipts WHERE last <= ?", floor);
      store.sql.exec("UPDATE file_meta SET receipt_floor = MAX(receipt_floor, ?) WHERE id = 1", floor);
    }
    return { versionsDropped, logDropped, receiptsDropped, rowsPurged };
  });
}

export class IntegrityError extends Error {}

/** Read a manifest and its objects back into a whole state, checking every object against its hash. */
export async function loadManifest(objects: FileRoom["objects"], manifestText: string, allowUnknownBlobPaths = false): Promise<{ manifest: Manifest; state: FileState }> {
  const m = JSON.parse(manifestText) as Manifest;
  if (!m || typeof m !== "object" || !Array.isArray(m.blobs)) throw new IntegrityError("invalid manifest");
  for (const b of m.blobs) if (!b || (checkBlobPath(b.path) && !(allowUnknownBlobPaths && safeBlobPath(b.path)))
    || !/^[0-9a-f]{64}$/.test(b.sha256) || !Number.isSafeInteger(b.bytes) || b.bytes <= 0) throw new IntegrityError("invalid blob path or metadata in manifest");
  if (!/^[A-Za-z0-9-]{1,100}$/.test(m.file) || !Array.isArray(m.boards) || m.boards.some(b => !/^[0-9a-f]{64}$/.test(b.sha256)) || !/^[0-9a-f]{64}$/.test(m.vers?.sha256)) throw new IntegrityError("invalid snapshot identity or hash");
  if (m.format !== 1) throw new IntegrityError(`manifest format ${m.format} is not one this Canvas reads`);
  const fetchText = async (key: string, sha: string) => {
    const gz = await objects.get(key);
    if (!gz) throw new IntegrityError(`${key} is missing`);
    const text = await gunzipText(gz);
    if (sha256Hex(text) !== sha) throw new IntegrityError(`${key} does not match its hash`);
    return text;
  };
  const children: DocNode[] = []; let total=0;
  if(m.boards.length>20_000 || m.blobs.reduce((n,b)=>n+b.bytes,0)>1024**3 || m.blobs.some(b=>b.bytes>100*1024*1024))throw new IntegrityError("Manifest exceeds file limits");
  for (const b of m.boards) { const text=await fetchText(boardKey(m.file,b.sha256),b.sha256);total+=text.length;if(total>500*1024*1024)throw new IntegrityError("File exceeds layer limit");children.push(JSON.parse(text)); }
  const vers = JSON.parse(await fetchText(versKey(m.file, m.vers.sha256), m.vers.sha256)) as Record<string, string>;
  const blobs: Record<string, BlobRow> = Object.fromEntries(m.blobs.map(b => [b.path, { sha256: b.sha256, bytes: b.bytes, type: b.type }]));
  return { manifest: m, state: { top: m.top, children, doc: m.doc, widgets: m.widgets, pages: m.pages, meta: m.meta, blobs, vers } };
}

/** A Mac's copy of the file as a snapshot holds it. */
export async function treeFromManifest(objects: FileRoom["objects"], manifestText: string, allowUnknownBlobPaths = false): Promise<{ manifest: Manifest; tree: MemoryTree }> {
  const { manifest, state } = await loadManifest(objects, manifestText, allowUnknownBlobPaths);
  return { manifest, tree: new MemoryTree(state) };
}

/** The manifest text of a kept snapshot, from the stored object (what GET /v1/files/:id/manifest serves). */
export async function manifestAt(room: FileRoom, seq: number): Promise<string | null> {
  const b = await room.objects.get(manifestKey(room.file, seq));
  return b ? fromUtf8(b) : null;
}

/**
 * Restore a kept version in place: the rows become that version, the epoch goes up (every socket gets `reset` and
 * every action made before is refused; the adapter sends `broadcast` to every socket), the log starts again at a new seq, and a snapshot of the restored
 * state is built so Macs can start from it.
 */
export function restoreVersion(room: FileRoom, seq: number): Promise<{ epoch: number; seq: number; broadcast: Extract<FileServerMessage, { type: "reset" }> }> {
  // One lock from reading the version to its new snapshot: collection cannot drop the version's objects in between.
  return room.exclusive(async () => {
    const row = room.store.sql.exec<{ manifest: string }>("SELECT manifest FROM snapshots WHERE seq = ? AND state = 'done'", seq).toArray()[0];
    if (!row) throw new Error(`no kept version at ${seq}`);
    const { state } = await loadManifest(room.objects, row.manifest);
    room.store.transactionSync(() => {
      const m = room.meta();
      room.tree.seq = m.seq;
      room.tree.load(state);
      room.store.sql.exec("DELETE FROM log; DELETE FROM text_edits");
      // The restore takes a seq of its own, so its snapshot never shares a seq with the version before it.
      room.store.sql.exec("UPDATE file_meta SET epoch = epoch + 1, seq = seq + 1, log_floor = seq + 1 WHERE id = 1");
    });
    room.tree.forget();
    await buildLocked(room, { label: `Restored from ${seq}` });
    const m = room.meta();
    return { epoch: m.epoch, seq: m.seq, broadcast: { type: "reset", epoch: m.epoch, reason: "restored" } };
  });
}
