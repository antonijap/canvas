// Where things are used: variables, text styles and components, counted from the stored tree, plus the
// facts the page needs about a node (is it a component or part of one, where is its main component).
// Pure over a parsed document; one index per document object, so a revision pays for it once.

import { createHash } from "node:crypto";
import { boardCache } from "./boardcache.ts";
import { buildIndex, expand, type CanvasDoc, type DocNode } from "./engine.ts";

export type Use = { id: string; board: string };

type Entry = { node: DocNode; board: string; parent: string | null; comp: string | null };

export type UsageIndex = {
  /** Every stored node by id. `comp` is the nearest reusable node at or above it. */
  nodes: Map<string, Entry>;
  /** variable name -> the nodes that reference it ($name), instance overrides included as "Inst/Child". */
  variables: Map<string, Use[]>;
  /** text style key (styleKey of its props) -> the text nodes that use it. */
  styles: Map<string, Use[]>;
  /** component id -> its instances (ref nodes). */
  instances: Map<string, Use[]>;
  /** variables that some node uses as its font family. */
  fontVars: Set<string>;
};

/** A short stable key for a text style's property set. */
export const styleKey = (props: Record<string, unknown>): string => createHash("sha1").update(JSON.stringify(props)).digest("hex").slice(0, 10);

/** The properties that make a text style (what textStylesOf groups by). */
export function textProps(n: DocNode): Record<string, unknown> {
  return {
    fontFamily: n.fontFamily ?? "Inter", // text without a family is drawn in Inter
    fontSize: n.fontSize,
    fontWeight: String(n.fontWeight ?? "400"),
    fill: n.fill,
    letterSpacing: n.letterSpacing,
    lineHeight: n.lineHeight,
  };
}

function refsIn(v: unknown, into: Set<string>): void {
  if (typeof v === "string") {
    if (v.length > 1 && v.charCodeAt(0) === 36) into.add(v.slice(1));
  } else if (Array.isArray(v)) {
    for (const x of v) refsIn(x, into);
  } else if (v && typeof v === "object") {
    for (const x of Object.values(v)) refsIn(x, into);
  }
}

const cache = new WeakMap<object, UsageIndex>();

/** One top-level board's share of the index, worked out once per board object (boardcache.ts). */
type Part = {
  nodes: [string, Entry][];
  variables: [string, Use][];
  styles: [string, Use][];
  instances: [string, Use][];
  fontVars: string[];
  /** marksOf's share: ids at or under a reusable node, and instance ids. */
  comps: string[];
  refs: string[];
  /** Reusable nodes, in tree order. */
  reusable: DocNode[];
};
const parts = boardCache<Part>();

function partOf(top: DocNode): Part {
  const hit = parts.get(top);
  if (hit) return hit;
  const p: Part = { nodes: [], variables: [], styles: [], instances: [], fontVars: [], comps: [], refs: [], reusable: [] };
  const board = String(top.id);
  const visit = (n: DocNode, parent: string | null, comp: string | null) => {
    const id = String(n.id);
    const mine = n.reusable === true ? id : comp;
    p.nodes.push([id, { node: n, board, parent, comp: mine }]);
    if (mine) p.comps.push(id);
    if (n.reusable === true) p.reusable.push(n);
    if (n.type === "ref") p.refs.push(id);
    if (n.type === "ref" && typeof n.ref === "string") p.instances.push([n.ref, { id, board }]);
    if (n.type === "text") p.styles.push([styleKey(textProps(n)), { id, board }]);
    // Variables: any property value that is "$name", in this node or in its instance overrides.
    for (const [k, v] of Object.entries(n)) {
      if (k === "children") continue;
      if (k === "descendants" && v && typeof v === "object") {
        for (const [path, over] of Object.entries(v as Record<string, unknown>)) {
          const names = new Set<string>();
          refsIn(over, names);
          for (const name of names) p.variables.push([name, { id: `${id}/${path}`, board }]);
        }
        continue;
      }
      const names = new Set<string>();
      refsIn(v, names);
      for (const name of names) p.variables.push([name, { id, board }]);
      if (k === "fontFamily") for (const name of names) p.fontVars.push(name);
    }
    for (const c of (n.children as DocNode[] | undefined) ?? []) visit(c, id, mine);
  };
  visit(top, null, null);
  parts.set(top, p);
  return p;
}

const partsOf = (doc: CanvasDoc): Part[] => doc.children.filter((t) => t && typeof t === "object").map(partOf);

export function usageIndex(doc: CanvasDoc): UsageIndex {
  const hit = cache.get(doc);
  if (hit) return hit;
  const ps = partsOf(doc);
  const variables = new Map<string, Use[]>(), styles = new Map<string, Use[]>(), instances = new Map<string, Use[]>(), fontVars = new Set<string>();
  const push = (m: Map<string, Use[]>, k: string, u: Use) => {
    const l = m.get(k);
    if (l) l.push(u);
    else m.set(k, [u]);
  };
  for (const p of ps) {
    for (const [k, u] of p.variables) push(variables, k, u);
    for (const [k, u] of p.styles) push(styles, k, u);
    for (const [k, u] of p.instances) push(instances, k, u);
    for (const f of p.fontVars) fontVars.add(f);
  }
  // Every node by id is the big one (one entry per node): merged on first use, which an edit's snapshot does not need.
  let nodes: Map<string, Entry> | undefined;
  const ix = {
    get nodes() {
      if (!nodes) {
        nodes = new Map();
        for (const p of ps) for (const [id, e] of p.nodes) nodes.set(id, e);
      }
      return nodes;
    },
    variables,
    styles,
    instances,
    fontVars,
  } as UsageIndex;
  cache.set(doc, ix);
  return ix;
}

/** Reusable nodes in tree order with the top-level board each sits in (what componentsOf lists). */
export function reusableNodes(doc: CanvasDoc): { node: DocNode; board: string }[] {
  const out: { node: DocNode; board: string }[] = [];
  for (const top of doc.children) {
    if (!top || typeof top !== "object") continue;
    // Deleted main components their instances still use (src/structure.ts) are not in the file's library.
    if ((top.metadata as Record<string, unknown> | undefined)?.canvasDeletedComponents === true) continue;
    for (const node of partOf(top).reusable) out.push({ node, board: String(top.id) });
  }
  return out;
}

/** variable name -> how many nodes reference it. Only variables that are used appear. */
export function variableCounts(doc: CanvasDoc): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of usageIndex(doc).variables) out[k] = v.length;
  return out;
}

export type Marks = { comps: string[]; refs: string[] };

/** The ids the page paints purple: reusable nodes and everything stored inside them, and every instance. */
export function marksOf(doc: CanvasDoc): Marks {
  const comps: string[] = [];
  const refs: string[] = [];
  for (const p of partsOf(doc)) {
    for (const id of p.comps) comps.push(id);
    for (const id of p.refs) refs.push(id);
  }
  return { comps, refs };
}

/**
 * Whether a node id (a stored id or an instance path "Inst/Child") belongs to a component or an
 * instance. Plain JS under its annotations: the page embeds this function's source.
 */
export function isComponentish(m: any, id: string): boolean {
  if (!m || !id) return false;
  let c = m.compSet, r = m.refSet;
  if (!c) { c = m.compSet = new Set(m.comps); r = m.refSet = new Set(m.refs); }
  if (c.has(id) || r.has(id)) return true;
  const i = id.indexOf("/");
  if (i < 0) return false;
  const first = id.slice(0, i);
  return c.has(first) || r.has(first);
}

export type ContextKind = "component" | "instance" | "inside-instance" | "inside-component" | "node";
export type ContextTarget = {
  id: string;
  name: string;
  type: string;
  kind: ContextKind;
  /** Top-level board the node (or its instance) sits in. */
  board: string;
  boardName: string;
  /** Component or instance, or part of one: the selection paints purple. */
  purple: boolean;
  /** Where "Go to main component" goes. `focus` is the node inside the component to select. */
  main?: { id: string; name: string; board: string; boardName: string; focus: string };
  /** The component whose instances "Select all instances" finds, and how many there are. */
  family?: { id: string; name: string; instances: number };
};

const label = (n: DocNode) => String(n.name ?? n.type ?? n.id);

/** What the right-click menu needs to know about a node id. Null when the id is not in the document. */
/** A video file a caption near a node names ("File: Desktop/x/promo.mp4"), as written. */
const VIDEO_PATH = /(?:~\/|\/)?(?:[\w.@-]+\/)*[\w.@ -]*?[\w@-]+\.(?:mp4|m4v|mov|webm)\b/i;
function textsUnder(n: DocNode, out: string[], depth = 0): void {
  if (depth > 4 || out.length > 40) return;
  if (n.type === "text" && typeof n.content === "string") out.push(n.content);
  for (const c of (n.children as DocNode[] | undefined) ?? []) textsUnder(c, out, depth + 1);
}

/**
 * "Embed video here": a frame or rectangle (an image placeholder, usually) outside any instance can take a
 * video card over it. `videoHint` is a video path a text near it names (its siblings and their children,
 * then one level up), so the file picker can start there.
 */
export function mediaSlot(doc: CanvasDoc, id: string): { media: boolean; videoHint?: string } {
  const ix = usageIndex(doc);
  const e = !id.includes("/") ? ix.nodes.get(id) : undefined;
  if (!e || (e.node.type !== "frame" && e.node.type !== "rectangle") || e.comp) return { media: false };
  let at: string | null = e.parent;
  for (let up = 0; up < 2 && at; up++) {
    const p = ix.nodes.get(at);
    if (!p) break;
    const texts: string[] = [];
    textsUnder(p.node, texts);
    for (const t of texts) {
      const m = VIDEO_PATH.exec(t);
      if (m) return { media: true, videoHint: m[0].trim() };
    }
    at = p.parent;
  }
  return { media: true };
}

/**
 * The component each layer on an instance path draws, by segment (undefined: not an instance): `root` is the stored
 * instance the path starts at. An outer instance can swap a nested one (src/overrides.ts), so the stored ref of a
 * nested instance is not always what it draws.
 */
function drawnRefs(doc: CanvasDoc, root: DocNode, segs: string[]): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  if (root.type !== "ref") return out;
  let n: DocNode | undefined;
  try { n = expand(buildIndex(doc), root, []); } catch { return out; }
  for (let i = 0; n && i < segs.length; i++) {
    const r = (n as Record<string, unknown>).__ref;
    out[i] = typeof r === "string" ? r : undefined;
    const want = segs.slice(0, i + 2).join("/");
    n = (Array.isArray(n.children) ? (n.children as DocNode[]) : []).find((c) => c && String(c.id) === want);
  }
  return out;
}

export function contextTarget(doc: CanvasDoc, id: string): ContextTarget | null {
  const ix = usageIndex(doc);
  const segs = id.split("/");
  const root = ix.nodes.get(segs[0]);
  if (!root) return null;
  const last = ix.nodes.get(segs[segs.length - 1]);
  if (!last) return null;
  const boardName = (b: string) => label(ix.nodes.get(b)?.node ?? ({ id: b } as DocNode));
  const compInfo = (compId: string, focus?: string) => {
    const c = ix.nodes.get(compId);
    // A deleted main component (kept hidden for its instances) has no place to go to.
    if (!c || (ix.nodes.get(c.board)?.node.metadata as Record<string, unknown> | undefined)?.canvasDeletedComponents === true) return undefined;
    return { id: compId, name: label(c.node), board: c.board, boardName: boardName(c.board), focus: focus ?? compId };
  };
  const base = { id, name: label(last.node), type: String(last.node.type ?? ""), board: root.board, boardName: boardName(root.board) };
  const familyOf = (compId: string): ContextTarget["family"] => {
    const c = ix.nodes.get(compId);
    return c ? { id: compId, name: label(c.node), instances: ix.instances.get(compId)?.length ?? 0 } : undefined;
  };
  // The deepest instance on the path, counting the node itself.
  let refSeg = -1;
  for (let i = 0; i < segs.length; i++) if (ix.nodes.get(segs[i])?.node.type === "ref") refSeg = i;
  // What each instance on a path draws: its stored ref, unless an outer instance swapped it (src/overrides.ts).
  const refAt = segs.length > 1 ? drawnRefs(doc, root.node, segs) : [];
  const refOf = (i: number) => refAt[i] ?? (ix.nodes.get(segs[i])?.node.ref as string | undefined);
  if (segs.length === 1) {
    const n = root.node;
    if (n.type === "ref" && typeof n.ref === "string") {
      return { ...base, kind: "instance", purple: true, main: compInfo(n.ref), family: familyOf(n.ref) };
    }
    if (n.reusable === true) return { ...base, kind: "component", purple: true, family: familyOf(String(n.id)) };
    if (root.comp) return { ...base, kind: "inside-component", purple: true, main: compInfo(root.comp, String(n.id)) };
    return { ...base, kind: "node", purple: false };
  }
  // A path "Inst/Child": the node lives inside the instance's component.
  const lastRef = refOf(segs.length - 1);
  if (last.node.type === "ref" && typeof lastRef === "string" && refSeg === segs.length - 1) {
    return { ...base, kind: "instance", purple: true, main: compInfo(lastRef), family: familyOf(lastRef) };
  }
  const holder = refSeg >= 0 ? refOf(refSeg) : undefined;
  if (typeof holder === "string") {
    const inside = last.comp === holder || last.comp === ix.nodes.get(holder)?.comp;
    return { ...base, kind: "inside-instance", purple: true, main: compInfo(holder, inside ? String(last.node.id) : holder), family: familyOf(holder) };
  }
  return { ...base, kind: "node", purple: false };
}

export type UsageKind = "variable" | "style" | "component";
export type UsageItem = { id: string; name: string; type: string; board: string; boardName: string };
export type UsageList = { kind: UsageKind; key: string; total: number; items: UsageItem[]; boards: Record<string, string> };

export const USAGE_CAP = 200;

/** The nodes behind a token, a text style or a component: up to USAGE_CAP of them, plus the true total. */
export function usageList(doc: CanvasDoc, kind: UsageKind, key: string): UsageList {
  const ix = usageIndex(doc);
  const all = (kind === "variable" ? ix.variables : kind === "style" ? ix.styles : ix.instances).get(key) ?? [];
  const items: UsageItem[] = [];
  const boards: Record<string, string> = {};
  for (const u of all.slice(0, USAGE_CAP)) {
    const last = ix.nodes.get(u.id.split("/").pop() ?? "")?.node;
    const b = ix.nodes.get(u.board)?.node;
    boards[u.id] = u.board;
    items.push({ id: u.id, name: last ? label(last) : u.id, type: String(last?.type ?? ""), board: u.board, boardName: b ? label(b) : u.board });
  }
  return { kind, key, total: all.length, items, boards };
}

// ---------- tokens library ----------

export type TokenValue = { theme: string; value: string };
export type TokenItem = { name: string; leaf: string; type: string; values: TokenValue[]; count: number };
export type TokenGroup = { title: string; items: TokenItem[] };
/** A top-level entry of a type section: a group of two or more tokens sharing a name family, or a single token. */
export type TokenEntry = TokenGroup | TokenItem;
export type TokenSection = { id: "colors" | "numbers" | "strings" | "fonts" | "other"; title: string; entries: TokenEntry[] };
export type StyleItem = { key: string; title: string; leaf: string; count: number; color: string | null };
export type StyleEntry = { title: string; items: StyleItem[] } | StyleItem;
export type TokenLibrary = { themes: string[]; variables: TokenSection[]; styles: StyleEntry[] };

/** The first name segment, split on "-", "/" or ".": "surface-card" -> "surface". Empty when there is no separator. */
export function nameFamily(name: string): string {
  const m = /^([^-/.]+)[-/.]/.exec(name);
  return m ? m[1] : "";
}

/** Entries in name order: a family with two or more members becomes a group, a lone name stays top level. */
export function groupByFamily<T>(items: T[], nameOf: (t: T) => string, leafOf: (t: T, family: string) => T, familyOf: (name: string) => string = nameFamily): ({ title: string; items: T[] } | T)[] {
  const fam = new Map<string, T[]>();
  for (const t of items) {
    const n = nameOf(t);
    const f = familyOf(n) || n.replace(/[-/.].*$/, "");
    const l = fam.get(f);
    if (l) l.push(t);
    else fam.set(f, [t]);
  }
  const out: ({ title: string; items: T[] } | T)[] = [];
  for (const [f, list] of fam) {
    if (list.length < 2) out.push(list[0]);
    else out.push({ title: f, items: list.map((t) => leafOf(t, f)) });
  }
  // Groups and singles interleave alphabetically by their top-level name.
  const key = (e: { title: string; items: T[] } | T) => ("items" in (e as object) ? (e as { title: string }).title : nameOf(e as T)).toLowerCase();
  return out.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

const SECTION_TITLES: Record<TokenSection["id"], string> = { colors: "Colors", numbers: "Numbers", strings: "Strings", fonts: "Fonts", other: "Other" };

function themeLabel(t: unknown): string {
  return t && typeof t === "object" ? Object.values(t as Record<string, unknown>).map(String).join(" / ") : "";
}

function valuesOf(def: unknown): TokenValue[] {
  const v = def && typeof def === "object" ? (def as { value?: unknown }).value : def;
  if (Array.isArray(v)) return v.map((x) => ({ theme: themeLabel((x as { theme?: unknown })?.theme), value: String((x as { value?: unknown })?.value ?? "") }));
  return [{ theme: "", value: String(v ?? "") }];
}

/** The variables and text styles as the shell lists them: by type, by name family, with theme values and usage counts. */
export function tokenLibrary(doc: CanvasDoc, styles: { key: string; props: Record<string, unknown>; count: number }[]): TokenLibrary {
  const ix = usageIndex(doc);
  const vars = (doc.variables ?? {}) as Record<string, unknown>;
  const themeSet: string[] = [];
  const buckets = new Map<TokenSection["id"], TokenItem[]>();
  for (const [name, def] of Object.entries(vars)) {
    const type = String((def as { type?: unknown })?.type ?? "other");
    const id: TokenSection["id"] = type === "color" ? "colors" : type === "number" ? "numbers" : type === "string" ? (ix.fontVars.has(name) || /^font/i.test(name) ? "fonts" : "strings") : "other";
    const values = valuesOf(def);
    for (const v of values) if (v.theme && !themeSet.includes(v.theme)) themeSet.push(v.theme);
    const item: TokenItem = { name, leaf: name, type, values, count: ix.variables.get(name)?.length ?? 0 };
    const l = buckets.get(id);
    if (l) l.push(item);
    else buckets.set(id, [item]);
  }
  const order: TokenSection["id"][] = ["colors", "numbers", "strings", "fonts", "other"];
  const variables = order
    .filter((id) => buckets.has(id))
    .map((id) => ({
      id,
      title: SECTION_TITLES[id],
      entries: groupByFamily(buckets.get(id)!, (t) => t.name, (t, f) => ({ ...t, leaf: t.name === f ? t.name : t.name.slice(f.length + 1) })) as TokenEntry[],
    }));
  const family = (family: unknown) => String(family ?? "Inter").replace(/^\$/, "");
  const styleItems: StyleItem[] = styles.map((s) => {
    const p = s.props;
    const fill = typeof p.fill === "string" && p.fill.startsWith("#") ? p.fill : null;
    const title = `${family(p.fontFamily)} ${p.fontSize ?? ""}/${p.fontWeight ?? ""}`;
    return { key: s.key, title, leaf: `${p.fontSize ?? ""}/${p.fontWeight ?? ""}`, count: s.count, color: fill };
  });
  const styleEntries = groupByFamily(styleItems, (t) => t.title, (t) => t, (title) => title.replace(/ \S*$/, "")) as StyleEntry[];
  return { themes: themeSet, variables, styles: styleEntries };
}

/** /api/context and /api/usage. Returns true when it answered. */
export function handleUsageRoute(url: URL, doc: CanvasDoc, reply: (v: unknown, status?: number) => void): boolean {
  if (url.pathname === "/api/context") {
    const t = contextTarget(doc, url.searchParams.get("id") ?? "");
    if (t) reply({ ...t, ...mediaSlot(doc, t.id) });
    else reply({ error: `no node "${url.searchParams.get("id")}"` }, 404);
    return true;
  }
  if (url.pathname === "/api/usage") {
    const kind = url.searchParams.get("kind");
    if (kind !== "variable" && kind !== "style" && kind !== "component") reply({ error: "kind must be variable, style or component" }, 400);
    else reply(usageList(doc, kind, url.searchParams.get("key") ?? ""));
    return true;
  }
  return false;
}
