// The Mac's side of the shared apply (cloud/core/files/apply.ts): a TreeAccess on a design file held as a copy on
// write document, its sidecar envelope (cards, pages, the other kept keys) and the package files it holds as blobs.
// Writes never touch the objects it was built from: each one copies the path from the root down to what it changes
// (once per action), so the document handed in stays as it was and `doc` is the new one. An id index (node, parent,
// and who uses each component) is built once and kept up to date, so no write walks the whole document.

import type { DocNode, Json } from "../cloud/core/schema.ts";
import type { BlobRow, NodeView, PageRow, TreeAccess, Ver } from "../cloud/core/files/apply.ts";
import { orderLike, refsOfNode } from "../cloud/core/files/apply.ts";

export type DocLike = { children: DocNode[]; [k: string]: unknown };
export type Envelope = { widgets: Record<string, unknown>[]; extra: Record<string, unknown> };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

type Undo = () => void;

export class DocTree implements TreeAccess {
  doc: DocLike;
  envelope: Envelope;
  blobs: Map<string, BlobRow>;
  private nodes = new Map<string, DocNode>();
  private parents = new Map<string, string | null>();
  /** Component id -> how many live nodes use it (own ref or override refs). */
  private users = new Map<string, number>();
  private vers = new Map<string, string>();
  /** Objects this action copied: safe to change in place until the action ends. */
  private owned = new WeakSet<object>();
  private envOwned = false;
  private undo: Undo[] | null = null;
  private saved: { doc: DocLike; envelope: Envelope } | null = null;

  constructor(doc: DocLike, envelope: Envelope = { widgets: [], extra: {} }, blobs: Iterable<[string, BlobRow]> = [], vers: Iterable<[string, string]> = []) {
    this.doc = doc;
    this.envelope = envelope;
    this.blobs = new Map(blobs);
    this.vers = new Map(vers);
    const index = (n: DocNode, parent: string | null) => {
      if (!isObj(n)) return;
      if (typeof n.id === "string" && !this.nodes.has(n.id)) {
        this.nodes.set(n.id, n);
        this.parents.set(n.id, parent);
        for (const r of refsOfNode(n as Record<string, Json>)) this.users.set(r, (this.users.get(r) ?? 0) + 1);
      }
      if (Array.isArray(n.children)) for (const c of n.children as DocNode[]) index(c, typeof n.id === "string" ? n.id : parent);
    };
    for (const c of doc.children ?? []) index(c, null);
  }

  // ---------- journal ----------

  private log(f: Undo) {
    this.undo?.push(f);
  }
  private mapSet<K, V>(m: Map<K, V>, k: K, v: V | undefined) {
    const had = m.has(k), old = m.get(k);
    this.log(() => (had ? m.set(k, old as V) : m.delete(k)));
    if (v === undefined) m.delete(k);
    else m.set(k, v);
  }
  begin(): void {
    this.undo = [];
    this.saved = { doc: this.doc, envelope: this.envelope };
    this.owned = new WeakSet();
    this.envOwned = false;
  }
  commit(): void {
    this.undo = null;
    this.saved = null;
  }
  rollback(): void {
    for (const f of (this.undo ?? []).reverse()) f();
    if (this.saved) ({ doc: this.doc, envelope: this.envelope } = this.saved);
    this.undo = null;
    this.saved = null;
    this.owned = new WeakSet();
    this.envOwned = false;
  }

  // ---------- reads ----------

  node(id: string): NodeView | null {
    const n = this.nodes.get(id);
    if (!n) return null;
    const props: Record<string, Json> = {};
    for (const k of Object.keys(n)) if (n[k] !== undefined) props[k] = k === "children" ? null : (n[k] as Json);
    return { id, parent: this.parents.get(id) ?? null, type: String(n.type), props };
  }
  children(parent: string | null): readonly string[] {
    const list = parent === null ? this.doc.children : (this.nodes.get(parent)?.children as DocNode[] | undefined);
    return Array.isArray(list) ? list.filter(isObj).map((c) => String(c.id)) : [];
  }
  ancestors(id: string, max: number): string[] {
    const out: string[] = [];
    for (let p = this.parents.get(id) ?? null; p !== null && out.length < max; p = this.parents.get(p) ?? null) out.push(p);
    return out;
  }
  subtree(id: string): DocNode | null {
    return this.nodes.get(id) ?? null;
  }
  isComponent(id: string): boolean {
    return this.nodes.get(id)?.reusable === true;
  }
  hasRefUsers(id: string): boolean {
    return (this.users.get(id) ?? 0) > 0;
  }
  docValue(key: "variables" | "themes" | "fonts"): Json | undefined {
    return this.doc[key] as Json | undefined;
  }
  widgetIds(): readonly string[] {
    return this.envelope.widgets.map((w) => String(w.id));
  }
  widget(id: string): Json | undefined {
    return this.envelope.widgets.find((w) => w.id === id) as Json | undefined;
  }
  pages(): readonly PageRow[] | null {
    const p = this.envelope.extra.pages;
    return Array.isArray(p) ? (p as PageRow[]) : null;
  }
  meta(key: string): Json | undefined {
    return this.envelope.extra[key] as Json | undefined;
  }
  blob(path: string): BlobRow | null {
    return this.blobs.get(path) ?? null;
  }
  ver(target: string): Ver {
    return this.vers.get(target) ?? 0;
  }
  allVers(): Record<string, string> {
    return Object.fromEntries(this.vers);
  }

  // ---------- copy on write ----------

  private ownDoc(): DocLike {
    if (!this.owned.has(this.doc)) {
      this.doc = { ...this.doc, children: this.doc.children.slice() };
      this.owned.add(this.doc);
    }
    return this.doc;
  }
  /** The node `id` as a copy this action owns, with every node above it copied too. */
  private own(id: string): DocNode {
    const n = this.nodes.get(id)!;
    if (this.owned.has(n)) return n;
    const parent = this.parents.get(id) ?? null;
    const list = parent === null ? this.ownDoc().children : (this.own(parent).children as DocNode[]);
    const copy = { ...n } as DocNode;
    if (Array.isArray(n.children)) copy.children = (n.children as DocNode[]).slice();
    this.owned.add(copy);
    const at = list.indexOf(n);
    if (at >= 0) list[at] = copy;
    this.mapSet(this.nodes, id, copy);
    return copy;
  }
  /** The children list of `parent`, owned. */
  private ownList(parent: string | null): DocNode[] {
    if (parent === null) return this.ownDoc().children;
    const p = this.own(parent);
    if (!Array.isArray(p.children)) p.children = [];
    return p.children as DocNode[];
  }
  private ownEnvelope(): Envelope {
    if (!this.envOwned) {
      this.envelope = { widgets: this.envelope.widgets.slice(), extra: { ...this.envelope.extra } };
      this.envOwned = true;
    }
    return this.envelope;
  }
  private countUsers(n: Record<string, unknown>, by: number) {
    for (const r of refsOfNode(n as Record<string, Json>)) this.mapSet(this.users, r, (this.users.get(r) ?? 0) + by || undefined);
  }
  private indexSubtree(n: DocNode, parent: string | null, by: 1 | -1) {
    if (!isObj(n)) return;
    const id = typeof n.id === "string" ? n.id : null;
    if (id !== null) {
      this.mapSet(this.nodes, id, by > 0 ? n : undefined);
      this.mapSet(this.parents, id, by > 0 ? parent : undefined);
      this.countUsers(n, by);
    }
    if (Array.isArray(n.children)) for (const c of n.children as DocNode[]) this.indexSubtree(c, id ?? parent, by);
  }

  // ---------- writes ----------

  writeProps(id: string, props: Record<string, Json>): void {
    const n = this.own(id);
    this.countUsers(n, -1);
    const kids = n.children;
    for (const k of Object.keys(n)) delete n[k];
    for (const [k, v] of Object.entries(props)) n[k] = k === "children" ? (kids as Json) : v;
    this.countUsers(n, 1);
  }
  insert(parent: string | null, index: number, node: DocNode): void {
    const list = this.ownList(parent);
    list.splice(Math.min(index, list.length), 0, node);
    this.indexSubtree(node, parent, 1);
    this.markOwned(node);
  }
  /** A subtree the apply cloned for us: ours to change. */
  private markOwned(n: DocNode) {
    if (!isObj(n)) return;
    this.owned.add(n);
    if (Array.isArray(n.children)) {
      this.owned.add(n.children);
      for (const c of n.children as DocNode[]) this.markOwned(c);
    }
  }
  remove(id: string): void {
    const n = this.nodes.get(id)!;
    const parent = this.parents.get(id) ?? null;
    const list = this.ownList(parent);
    const at = list.indexOf(n);
    if (at >= 0) list.splice(at, 1);
    this.indexSubtree(n, parent, -1);
  }
  move(id: string, parent: string | null, index: number): void {
    const n = this.own(id);
    const from = this.parents.get(id) ?? null;
    const src = this.ownList(from);
    src.splice(src.indexOf(n), 1);
    const dest = this.ownList(parent);
    dest.splice(Math.min(index, dest.length), 0, n);
    this.mapSet(this.parents, id, parent);
  }
  writeDocValue(key: "variables" | "themes" | "fonts", value: Json | undefined): void {
    const d = this.ownDoc();
    if (value === undefined) delete d[key];
    else d[key] = value;
  }
  orderDocKeys(order: string[]): void {
    const d = this.ownDoc();
    this.doc = Object.fromEntries(orderLike(Object.keys(d), order).map((k) => [k, d[k]])) as DocLike;
    this.owned.add(this.doc);
  }
  writeWidget(id: string, value: Json | undefined, index: number | undefined): void {
    const env = this.ownEnvelope();
    const at = env.widgets.findIndex((w) => w.id === id);
    if (value === undefined) {
      if (at >= 0) env.widgets.splice(at, 1);
      return;
    }
    if (index === undefined) {
      if (at >= 0) env.widgets[at] = value as Record<string, unknown>;
      else env.widgets.push(value as Record<string, unknown>);
      return;
    }
    if (at >= 0) env.widgets.splice(at, 1);
    env.widgets.splice(Math.min(index, env.widgets.length), 0, value as Record<string, unknown>);
  }
  writePages(list: PageRow[] | null): void {
    const env = this.ownEnvelope();
    if (list === null) delete env.extra.pages;
    else env.extra.pages = list.map((p) => ({ id: p.id, name: p.name, boards: [...p.boards] }));
  }
  writeMeta(key: string, value: Json | undefined): void {
    const env = this.ownEnvelope();
    if (value === undefined) delete env.extra[key];
    else env.extra[key] = value;
  }
  addBlob(path: string, row: BlobRow): void {
    this.mapSet(this.blobs, path, row);
  }
  setVer(target: string, ver: string): void {
    this.mapSet(this.vers, target, ver);
  }
}
