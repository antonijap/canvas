// The shared apply's TreeAccess on a plain in-memory copy of a file: what a Mac keeps as its confirmed state in tests
// and the fuzz run, and the cross check for the room's SQL rows. Removed nodes leave the tree here (the SQL rows keep a
// tombstone instead); both read the same through TreeAccess.

import { refsOfNode, type BlobRow, type DocNode, type Json, type NodeView, type PageRow, type Ver } from "./seam.ts";
import type { DocValueKey, FileState, RoomTree } from "./state.ts";

type Slot = { node: DocNode; parent: string | null };
const isArr = Array.isArray;
const clone = <T>(v: T): T => structuredClone(v);

export class MemoryTree implements RoomTree {
  private s: FileState;
  private index = new Map<string, Slot>();
  private saved: FileState | null = null;

  constructor(state: FileState) {
    this.s = clone(state);
    this.reindex();
  }
  /** A deep copy that changes apart from this one. */
  copy(): MemoryTree {
    return new MemoryTree(this.s);
  }
  state(): FileState {
    return clone(this.s);
  }

  private reindex(): void {
    this.index.clear();
    const walk = (list: DocNode[], parent: string | null) => {
      for (const n of list) {
        this.index.set(n.id as string, { node: n, parent });
        if (isArr(n.children)) walk(n.children, n.id as string);
      }
    };
    walk(this.s.children, null);
  }
  private listOf(parent: string | null): DocNode[] {
    if (parent === null) return this.s.children;
    const n = this.index.get(parent)!.node;
    if (!isArr(n.children)) n.children = [];
    return n.children;
  }

  node(id: string): NodeView | null {
    const slot = typeof id === "string" ? this.index.get(id) : undefined;
    if (!slot) return null;
    const props: Record<string, Json> = {};
    for (const [k, v] of Object.entries(slot.node)) props[k] = k === "children" ? null : clone(v as Json);
    return { id, parent: slot.parent, type: slot.node.type as string, props };
  }
  children(parent: string | null): readonly string[] {
    if (parent !== null && !this.index.has(parent)) return [];
    const n = parent === null ? null : this.index.get(parent)!.node;
    const list = n === null ? this.s.children : isArr(n.children) ? n.children : [];
    return list.map((c) => c.id as string);
  }
  ancestors(id: string, max: number): string[] {
    const out: string[] = [];
    let p = this.index.get(id)?.parent ?? null;
    while (p !== null && out.length < max) {
      out.push(p);
      p = this.index.get(p)?.parent ?? null;
    }
    return out;
  }
  subtree(id: string): DocNode | null {
    const slot = this.index.get(id);
    return slot ? clone(slot.node) : null;
  }
  isComponent(id: string): boolean {
    return this.index.get(id)?.node.reusable === true;
  }
  hasRefUsers(id: string): boolean {
    for (const { node } of this.index.values()) if (refsOfNode(node).includes(id)) return true;
    return false;
  }
  docValue(key: DocValueKey): Json | undefined {
    return this.s.doc[key] === undefined ? undefined : clone(this.s.doc[key]);
  }
  widgetIds(): readonly string[] {
    return this.s.widgets.map((w, i) => (w && typeof w === "object" && !isArr(w) && typeof w.id === "string" ? w.id : `w${i}`));
  }
  widget(id: string): Json | undefined {
    const i = this.widgetIds().indexOf(id);
    return i < 0 ? undefined : clone(this.s.widgets[i]);
  }
  pages(): readonly PageRow[] | null {
    return this.s.pages ? clone(this.s.pages) : null;
  }
  meta(key: string): Json | undefined {
    return Object.hasOwn(this.s.meta, key) ? clone(this.s.meta[key]) : undefined;
  }
  blob(path: string): BlobRow | null {
    return Object.hasOwn(this.s.blobs, path) ? { ...this.s.blobs[path] } : null;
  }
  blobPaths(): string[] {
    return Object.keys(this.s.blobs).sort();
  }
  ver(target: string): Ver {
    return Object.hasOwn(this.s.vers, target) ? this.s.vers[target] : 0;
  }
  allVers(): Record<string, string> {
    return { ...this.s.vers };
  }
  topKeys(): Record<string, Json> {
    return clone(this.s.top);
  }

  begin(): void {
    this.saved = clone(this.s);
  }
  commit(): void {
    this.saved = null;
  }
  rollback(): void {
    if (this.saved) {
      this.s = this.saved;
      this.saved = null;
      this.reindex();
    }
  }

  writeProps(id: string, props: Record<string, Json>): void {
    const n = this.index.get(id)!.node;
    const kids = isArr(n.children) ? n.children : [];
    for (const k of Object.keys(n)) delete n[k];
    for (const [k, v] of Object.entries(props)) n[k] = k === "children" ? (kids as unknown as Json) : v;
  }
  insert(parent: string | null, index: number, node: DocNode): void {
    const n = clone(node);
    this.listOf(parent).splice(index, 0, n);
    const walk = (x: DocNode, p: string | null) => {
      this.index.set(x.id as string, { node: x, parent: p });
      for (const c of isArr(x.children) ? x.children : []) walk(c, x.id as string);
    };
    walk(n, parent);
  }
  remove(id: string): void {
    const slot = this.index.get(id)!;
    const list = this.listOf(slot.parent);
    list.splice(list.indexOf(slot.node), 1);
    const drop = (x: DocNode) => {
      this.index.delete(x.id as string);
      for (const c of isArr(x.children) ? x.children : []) drop(c);
    };
    drop(slot.node);
  }
  move(id: string, parent: string | null, index: number): void {
    const slot = this.index.get(id)!;
    const from = this.listOf(slot.parent);
    from.splice(from.indexOf(slot.node), 1);
    this.listOf(parent).splice(index, 0, slot.node);
    slot.parent = parent;
  }
  writeDocValue(key: DocValueKey, value: Json | undefined): void {
    if (value === undefined) delete this.s.doc[key];
    else this.s.doc[key] = value;
  }
  writeWidget(id: string, value: Json | undefined, index: number | undefined): void {
    const ids = this.widgetIds();
    const at = ids.indexOf(id);
    if (value === undefined) {
      if (at >= 0) this.s.widgets.splice(at, 1);
      return;
    }
    if (index === undefined && at >= 0) {
      this.s.widgets[at] = value;
      return;
    }
    if (at >= 0) this.s.widgets.splice(at, 1);
    this.s.widgets.splice(index ?? this.s.widgets.length, 0, value);
  }
  writePages(list: PageRow[] | null): void {
    this.s.pages = list === null ? null : clone(list);
  }
  writeMeta(key: string, value: Json | undefined): void {
    if (value === undefined) delete this.s.meta[key];
    else this.s.meta[key] = value;
  }
  addBlob(path: string, row: BlobRow): void {
    this.s.blobs[path] = { ...row };
  }
  setVer(target: string, ver: string): void {
    this.s.vers[target] = ver;
  }
}
