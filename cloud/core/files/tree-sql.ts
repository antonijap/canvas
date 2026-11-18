// The shared apply's TreeAccess on a room's SQL rows (room-schema.ts). Used only inside store.transactionSync: begin,
// commit and rollback are bookkeeping here, because a Durable Object's SQL cannot open savepoints itself. A rejected
// action must throw out of the transaction (room.ts does) so SQLite puts every row back.

import type { SqlStore, SqlValue } from "../sql.ts";
import { refsOfNode, ApplyError, type BlobRow, type DocNode, type Json, type NodeView, type PageRow, type Ver } from "./seam.ts";
import { keyAt, evenKeys } from "./positions.ts";
import type { DocValueKey, FileState, RoomTree } from "./state.ts";

type Row = { id: string; parent: string; pos: string; type: string; props: string; deleted_seq: number | null };
const MAX_DEPTH = 1024;
/** Caps (Section 3): a node row (a Durable Object row holds 2 MB; a little is kept for the other columns), boards per file. */
export const ROW_CAP = 2 * 1024 * 1024 - 4096;
export const BOARD_CAP = 20_000;
const isArr = Array.isArray;

export class SqlTree implements RoomTree {
  /** The seq this action's writes are stamped with (removals). */
  seq = 0;
  /** Statements that wrote rows since the last reset: the room's honest meter of rows written. */
  rowsWritten = 0;
  rowsRead = 0;
  /** Change in node JSON bytes since the room last read it (the file cap counts these). */
  bytesDelta = 0;
  private cache = new Map<string, Row | null>();
  private readonly store: SqlStore;
  constructor(store: SqlStore) {
    this.store = store;
  }

  private q<T extends Record<string, SqlValue>>(query: string, ...b: unknown[]): T[] {
    const rows = this.store.sql.exec<T>(query, ...b).toArray();
    this.rowsRead += rows.length;
    return rows;
  }
  private w(query: string, ...b: unknown[]): void {
    this.store.sql.exec(query, ...b);
    this.rowsWritten++;
  }
  /** Forget cached rows (after a rollback, or when another writer changed the rows). */
  forget(): void {
    this.cache.clear();
  }

  private row(id: string): Row | null {
    if (this.cache.has(id)) return this.cache.get(id)!;
    const r = this.q<Row>("SELECT id, parent, pos, type, props, deleted_seq FROM nodes WHERE id = ?", id)[0] ?? null;
    this.cache.set(id, r);
    return r;
  }
  private isLive(id: string): boolean {
    let r = this.row(id);
    for (let i = 0; r && i < MAX_DEPTH; i++) {
      if (r.deleted_seq !== null) return false;
      if (r.parent === "") return true;
      r = this.row(r.parent);
    }
    return false;
  }
  /** The top level node above `id` (itself at the top), live or not: the board a change dirties. */
  private boardOf(id: string): string | null {
    let r = this.row(id);
    for (let i = 0; r && i < MAX_DEPTH; i++) {
      if (r.parent === "") return r.id;
      r = this.row(r.parent);
    }
    return null;
  }
  private dirty(board: string | null): void {
    if (board) this.w("INSERT OR IGNORE INTO dirty_boards (board) VALUES (?)", board);
  }

  // Reads.
  node(id: string): NodeView | null {
    if (typeof id !== "string" || !this.isLive(id)) return null;
    const r = this.row(id)!;
    return { id: r.id, parent: r.parent === "" ? null : r.parent, type: r.type, props: JSON.parse(r.props) };
  }
  children(parent: string | null): readonly string[] {
    return this.q<{ id: string }>("SELECT id FROM nodes WHERE parent = ? AND deleted_seq IS NULL ORDER BY pos, id", parent ?? "").map((r) => r.id);
  }
  private childRows(parent: string | null): { id: string; pos: string }[] {
    return this.q<{ id: string; pos: string }>("SELECT id, pos FROM nodes WHERE parent = ? AND deleted_seq IS NULL ORDER BY pos, id", parent ?? "");
  }
  ancestors(id: string, max: number): string[] {
    const out: string[] = [];
    let r = this.row(id);
    while (r && r.parent !== "" && out.length < max && out.length < MAX_DEPTH) {
      out.push(r.parent);
      r = this.row(r.parent);
    }
    return out;
  }
  subtree(id: string): DocNode | null {
    if (!this.isLive(id)) return null;
    return this.build(id);
  }
  private build(id: string): DocNode {
    const r = this.row(id)!;
    const props = JSON.parse(r.props) as Record<string, Json>;
    if (Object.hasOwn(props, "children")) props.children = this.children(id).map((c) => this.build(c) as Json);
    return props as DocNode;
  }
  isComponent(id: string): boolean {
    const n = this.node(id);
    return !!n && n.props.reusable === true;
  }
  hasRefUsers(id: string): boolean {
    for (const { user } of this.q<{ user: string }>("SELECT user FROM refs WHERE ref = ?", id)) if (this.isLive(user)) return true;
    return false;
  }
  private kv(key: string): Json | undefined {
    const r = this.q<{ json: string }>("SELECT json FROM kv WHERE key = ?", key)[0];
    return r ? (JSON.parse(r.json) as Json) : undefined;
  }
  docValue(key: DocValueKey): Json | undefined {
    return this.kv(`doc/${key}`);
  }
  widgetIds(): readonly string[] {
    return this.q<{ id: string }>("SELECT id FROM widgets ORDER BY pos, id").map((r) => r.id);
  }
  widget(id: string): Json | undefined {
    const r = this.q<{ json: string }>("SELECT json FROM widgets WHERE id = ?", id)[0];
    return r ? (JSON.parse(r.json) as Json) : undefined;
  }
  pages(): readonly PageRow[] | null {
    const v = this.kv("pages");
    return v === undefined ? null : (v as unknown as PageRow[]);
  }
  meta(key: string): Json | undefined {
    return this.kv(`meta/${key}`);
  }
  blob(path: string): BlobRow | null {
    const r = this.q<{ sha256: string; bytes: number; type: string }>("SELECT sha256, bytes, type FROM blobs WHERE path = ?", path)[0];
    return r ? { sha256: r.sha256, bytes: r.bytes, type: r.type } : null;
  }
  blobPaths(): string[] {
    return this.q<{ path: string }>("SELECT path FROM blobs ORDER BY path").map((r) => r.path);
  }
  ver(target: string): Ver {
    return this.q<{ action: string }>("SELECT action FROM vers WHERE target = ?", target)[0]?.action ?? 0;
  }
  allVers(): Record<string, string> {
    return Object.fromEntries(this.q<{ target: string; action: string }>("SELECT target, action FROM vers ORDER BY target").map((r) => [r.target, r.action]));
  }
  topKeys(): Record<string, Json> {
    return JSON.parse(this.q<{ top_json: string }>("SELECT top_json FROM file_meta WHERE id = 1")[0].top_json);
  }

  // Writes.
  begin(): void {
    this.forget();
  }
  commit(): void {}
  rollback(): void {
    this.forget();
  }

  /** A node row's JSON, refused when it would pass the row cap (a Durable Object row holds at most 2 MB). */
  private rowJson(id: string, props: Record<string, Json>): string {
    const s = JSON.stringify(props);
    const size = s.length > ROW_CAP / 3 ? new TextEncoder().encode(s).length : s.length;
    if (size > ROW_CAP) throw new ApplyError("invalid", `"${id}" would hold ${Math.round(size / 1024)} KB; a layer holds at most 2 MB`);
    return s;
  }
  private writeRow(id: string, parent: string, pos: string, type: string, props: Record<string, Json>): void {
    const json = this.rowJson(id, props);
    this.w("INSERT INTO nodes (id, parent, pos, type, props, deleted_seq) VALUES (?, ?, ?, ?, ?, NULL)", id, parent, pos, type, json);
    this.bytesDelta += json.length;
    this.cache.delete(id);
    for (const ref of new Set(refsOfNode(props))) this.w("INSERT OR IGNORE INTO refs (ref, user) VALUES (?, ?)", ref, id);
  }
  /** Drop the rows of `id` and everything stored under it (a removed subtree an insert brings back by id). */
  private purge(id: string): void {
    const rows = this.q<{ id: string; n: number }>(
      "WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT n.id FROM nodes n JOIN sub ON n.parent = sub.id) SELECT sub.id AS id, length(nodes.props) AS n FROM sub JOIN nodes ON nodes.id = sub.id",
      id,
    );
    for (const x of rows) {
      this.w("DELETE FROM nodes WHERE id = ?", x.id);
      this.w("DELETE FROM refs WHERE user = ?", x.id);
      this.bytesDelta -= x.n;
      this.cache.delete(x.id);
    }
  }
  /** Make sure a container's props say where its children list sits. */
  private ensureChildrenKey(parent: string | null): void {
    if (parent === null) return;
    const r = this.row(parent)!;
    const props = JSON.parse(r.props) as Record<string, Json>;
    if (Object.hasOwn(props, "children")) return;
    props.children = null;
    const json = this.rowJson(parent, props);
    this.w("UPDATE nodes SET props = ? WHERE id = ?", json, parent);
    this.bytesDelta += json.length - r.props.length;
    this.cache.delete(parent);
  }
  /** A new top level board: refused past BOARD_CAP. */
  private roomForBoard(): void {
    const n = this.q<{ n: number }>("SELECT COUNT(*) AS n FROM nodes WHERE parent = '' AND deleted_seq IS NULL")[0].n;
    if (n >= BOARD_CAP) throw new ApplyError("invalid", `a file holds at most ${BOARD_CAP} boards`);
  }
  /** A position key for `index` among `siblings`, renumbering them when the key would grow too long. */
  private placeAmong(siblings: { id: string; pos: string }[], index: number, table: "nodes" | "widgets"): string {
    const { key, renumber } = keyAt(siblings.map((s) => s.pos), index);
    if (renumber) {
      const others = renumber.filter((_, i) => i !== index);
      siblings.forEach((s, i) => {
        this.w(`UPDATE ${table} SET pos = ? WHERE id = ?`, others[i], s.id);
        if (table === "nodes") this.cache.delete(s.id);
      });
    }
    return key;
  }

  writeProps(id: string, props: Record<string, Json>): void {
    const r = this.row(id)!;
    const json = this.rowJson(id, props);
    this.w("UPDATE nodes SET props = ? WHERE id = ?", json, id);
    this.bytesDelta += json.length - r.props.length;
    this.cache.delete(id);
    this.w("DELETE FROM refs WHERE user = ?", id);
    for (const ref of new Set(refsOfNode(props))) this.w("INSERT OR IGNORE INTO refs (ref, user) VALUES (?, ?)", ref, id);
    this.dirty(this.boardOf(r.id));
  }
  insert(parent: string | null, index: number, node: DocNode): void {
    const ids: string[] = [];
    const collect = (n: DocNode) => {
      ids.push(n.id as string);
      for (const c of isArr(n.children) ? n.children : []) collect(c);
    };
    collect(node);
    for (const id of ids) if (this.row(id)) this.purge(id);
    if (parent === null) this.roomForBoard();
    this.ensureChildrenKey(parent);
    const pos = this.placeAmong(this.childRows(parent), index, "nodes");
    this.insertTree(node, parent ?? "", pos);
    this.dirty(parent === null ? (node.id as string) : this.boardOf(parent));
  }
  private insertTree(n: DocNode, parent: string, pos: string): void {
    const props: Record<string, Json> = {};
    for (const [k, v] of Object.entries(n)) props[k] = k === "children" && isArr(v) ? null : (v as Json);
    this.writeRow(n.id as string, parent, pos, n.type as string, props);
    if (isArr(n.children)) {
      const keys = evenKeys(n.children.length);
      n.children.forEach((c, i) => this.insertTree(c, n.id as string, keys[i]));
    }
  }
  remove(id: string): void {
    this.dirty(this.boardOf(id));
    this.w("UPDATE nodes SET deleted_seq = ? WHERE id = ?", this.seq, id);
    this.cache.delete(id);
  }
  move(id: string, parent: string | null, index: number): void {
    this.dirty(this.boardOf(id));
    if (parent === null && this.row(id)!.parent !== "") this.roomForBoard();
    this.ensureChildrenKey(parent);
    const siblings = this.childRows(parent).filter((s) => s.id !== id);
    const pos = this.placeAmong(siblings, index, "nodes");
    this.w("UPDATE nodes SET parent = ?, pos = ? WHERE id = ?", parent ?? "", pos, id);
    this.cache.delete(id);
    this.dirty(this.boardOf(id));
  }
  private writeKv(key: string, value: Json | undefined): void {
    if (value === undefined) this.w("DELETE FROM kv WHERE key = ?", key);
    else this.w("INSERT INTO kv (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json", key, JSON.stringify(value));
  }
  writeDocValue(key: DocValueKey, value: Json | undefined): void {
    this.writeKv(`doc/${key}`, value);
  }
  writeWidget(id: string, value: Json | undefined, index: number | undefined): void {
    if (value === undefined) {
      this.w("DELETE FROM widgets WHERE id = ?", id);
      return;
    }
    const all = this.q<{ id: string; pos: string }>("SELECT id, pos FROM widgets ORDER BY pos, id");
    const has = all.some((w) => w.id === id);
    if (index === undefined && has) {
      this.w("UPDATE widgets SET json = ? WHERE id = ?", JSON.stringify(value), id);
      return;
    }
    const others = all.filter((w) => w.id !== id);
    const pos = this.placeAmong(others, index ?? others.length, "widgets");
    this.w("INSERT INTO widgets (id, pos, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET pos = excluded.pos, json = excluded.json", id, pos, JSON.stringify(value));
  }
  writePages(list: PageRow[] | null): void {
    this.writeKv("pages", list === null ? undefined : (list as unknown as Json));
  }
  writeMeta(key: string, value: Json | undefined): void {
    this.writeKv(`meta/${key}`, value);
  }
  addBlob(path: string, row: BlobRow): void {
    this.w("INSERT INTO blobs (path, sha256, bytes, type, added_seq) VALUES (?, ?, ?, ?, ?)", path, row.sha256, row.bytes, row.type, this.seq);
  }
  setVer(target: string, ver: string): void {
    this.w("INSERT INTO vers (target, action) VALUES (?, ?) ON CONFLICT(target) DO UPDATE SET action = excluded.action", target, ver);
  }

  /** Replace every row of the file's state (a seed, an import, a restore). Runs inside the caller's transaction. */
  load(state: FileState): void {
    for (const t of ["nodes", "refs", "vers", "kv", "widgets", "blobs", "dirty_boards"]) this.w(`DELETE FROM ${t}`);
    this.forget();
    this.w("UPDATE file_meta SET top_json = ? WHERE id = 1", JSON.stringify(state.top));
    const keys = evenKeys(state.children.length);
    state.children.forEach((c, i) => {
      this.insertTree(c, "", keys[i]);
      // Every board is new to the rows: a snapshot must write it, never reuse an object from before.
      this.dirty(c.id as string);
    });
    for (const [k, v] of Object.entries(state.doc)) if (v !== undefined) this.writeKv(`doc/${k}`, v);
    const wkeys = evenKeys(state.widgets.length);
    state.widgets.forEach((w, i) => {
      const id = w && typeof w === "object" && !isArr(w) && typeof w.id === "string" ? w.id : `w${i}`;
      this.w("INSERT INTO widgets (id, pos, json) VALUES (?, ?, ?)", id, wkeys[i], JSON.stringify(w));
    });
    if (state.pages) this.writeKv("pages", state.pages as unknown as Json);
    for (const [k, v] of Object.entries(state.meta)) this.writeKv(`meta/${k}`, v);
    for (const [p, b] of Object.entries(state.blobs)) this.w("INSERT INTO blobs (path, sha256, bytes, type, added_seq) VALUES (?, ?, ?, ?, ?)", p, b.sha256, b.bytes, b.type, this.seq);
    for (const [t, a] of Object.entries(state.vers)) this.w("INSERT INTO vers (target, action) VALUES (?, ?)", t, a);
    this.w("UPDATE file_meta SET node_bytes = (SELECT COALESCE(SUM(length(props)), 0) FROM nodes) WHERE id = 1");
    this.bytesDelta = 0;
  }

  /** Drop removed subtrees whose removal is at or before `seq` (compaction). Returns the rows dropped. */
  purgeRemoved(seq: number): number {
    const roots = this.q<{ id: string }>("SELECT id FROM nodes WHERE deleted_seq IS NOT NULL AND deleted_seq <= ?", seq);
    const before = this.rowsWritten;
    for (const r of roots) if (this.row(r.id)) this.purge(r.id);
    return this.rowsWritten - before;
  }
}
