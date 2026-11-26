// Inline text editing (src/page/text-edit.js): the page edits a text layer in place and writes once,
// when the edit ends. One write, one undo step ("Edit Text"), never merged with the step before it.
//
// POST /api/text {file, id, content, spans?, expectedRevision?} → {ok, changed, deleted?, revision?} (spans: styled ranges)
// POST /api/replace {file, query, replacement, matchCase?, wholeWord?, only?: {id, start}} → {ok, replaced, layers, ids}
// - A text layer in the tree: its `content`.
// - A text layer inside a component instance ("Inst/Label", "Inst/Nested/Label"): an override in the outer
//   instance's `descendants`, keyed by the path below it (the component itself is left alone). An
//   override that replaces the node is edited in place; a layer below a replacement instance gets its override on
//   that replacement. Same addressing as the scale tool (src/scale.ts).
// - Empty text deletes a layer of the tree (the step is then "Delete", still one step). A layer inside
//   an instance cannot be deleted from the instance: it keeps an empty override instead.

import type http from "node:http";
import { buildIndex, expand, findNode, StaleFileError, updateNode, ValidationError, walk, type Json, type CanvasDoc, type DocNode } from "./engine.ts";
import { findAll, replaceableText } from "./search.ts";
import { isTextLayer } from "./page/whiteboard-model.js";
import { follow as followSpans, normalize as normalizeSpans, shift as shiftSpans, spanErrors, type Span } from "./page/text-spans.js";
import { followLists, listErrors, normalizeLists, paragraphCount, type ListItem } from "./page/text-paras.js";
import { currentDoc, editDoc } from "./docwriter.ts";
import { nodeDiff, propsOf, record, type NodeOp } from "./history.ts";
import { replacementsIn, storedIndex } from "./scale.ts";
import { runStructure, StructureError } from "./structure.ts";
import { readBodyText } from "./body.ts";

export const MAX_TEXT = 500_000;

export class TextEditError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Where an edit of a scene id is stored. */
export type TextTarget =
  | { kind: "node"; id: string }
  | { kind: "override"; inst: string; key: string }
  | { kind: "repOverride"; inst: string; rep: string; key: string }
  | { kind: "replacement"; inst: string; id: string };

/** The stored instance whose overrides hold a replacement node with this id, or undefined. */
function replacementOwner(stored: Map<string, DocNode>, id: string): string | undefined {
  for (const [sid, s] of stored) {
    if (s.type !== "ref" || !s.descendants || typeof s.descendants !== "object") continue;
    if (replacementsIn(s.descendants as Record<string, DocNode>).has(id)) return sid;
  }
  return undefined;
}

/** Where the content of scene id `id` is stored, or undefined when Canvas cannot say (edit the component). */
export function textTarget(doc: CanvasDoc, id: string, stored = storedIndex(doc)): TextTarget | undefined {
  if (!id.includes("/")) {
    if (stored.has(id)) return { kind: "node", id };
    const inst = replacementOwner(stored, id);
    return inst ? { kind: "replacement", inst, id } : undefined;
  }
  const head = id.slice(0, id.indexOf("/")), key = id.slice(head.length + 1);
  if (!key) return undefined;
  if (stored.get(head)?.type === "ref") return { kind: "override", inst: head, key };
  const owner = replacementOwner(stored, head);
  if (owner) {
    const rep = replacementsIn(stored.get(owner)!.descendants as Record<string, DocNode>).get(head);
    if (rep?.type === "ref") return { kind: "repOverride", inst: owner, rep: head, key };
  }
  return undefined;
}

/** Whether the stored layer (or instance) a scene id starts from is still in the file. */
function anchorExists(doc: CanvasDoc, id: string): boolean {
  const stored = storedIndex(doc);
  const head = id.includes("/") ? id.slice(0, id.indexOf("/")) : id;
  return stored.has(head) || replacementOwner(stored, head) !== undefined;
}

/** "$name" when the node's content is a reference to a variable the document defines, else undefined. */
export function boundVariable(doc: CanvasDoc, n: DocNode): string | undefined {
  const c = n.content;
  if (typeof c !== "string" || !c.startsWith("$") || c.length < 2) return undefined;
  const vars = doc.variables as Record<string, unknown> | undefined;
  return vars && Object.prototype.hasOwnProperty.call(vars, c.slice(1)) ? c : undefined;
}

/** The node as drawn (instances expanded) for a scene id, from the board that holds its stored anchor. */
export function drawnNode(doc: CanvasDoc, t: TextTarget, id: string): DocNode | undefined {
  const anchor = t.kind === "node" ? t.id : t.inst;
  let top: DocNode;
  try {
    const f = findNode(doc, anchor);
    top = f.ancestors[0] ?? f.node;
  } catch {
    return undefined;
  }
  const seek = (n: DocNode): DocNode | undefined => {
    if (!n || typeof n !== "object") return undefined;
    if (String(n.id) === id) return n;
    for (const c of Array.isArray(n.children) ? (n.children as DocNode[]) : []) {
      const hit = seek(c);
      if (hit) return hit;
    }
    return undefined;
  };
  return seek(expand(buildIndex(doc), top, []));
}

/** Put `content` where the target stores it. `doc` is the copy the write changes. */
function applyContent(doc: CanvasDoc, t: TextTarget, content: string, spans?: Span[], lists?: ListItem[]): void {
  // Styled ranges and lists ride along when the edit sends them (an empty list takes them off).
  const put = (n: Record<string, unknown>) => {
    n.content = content;
    if (spans) { if (spans.length) n.spans = spans; else delete n.spans; }
    if (lists) { if (lists.length) n.lists = lists; else delete n.lists; }
  };
  const merge = (d: Record<string, DocNode>, key: string) => {
    const have = d[key];
    if (have && typeof have === "object" && have.type) put(have);
    else { const o = { ...(have && typeof have === "object" ? have : {}) } as Record<string, unknown>; put(o); d[key] = o as DocNode; }
  };
  if (t.kind === "node") {
    const props: Record<string, Json> = { content };
    const remove: string[] = [];
    if (spans) { if (spans.length) props.spans = spans as unknown as Json; else remove.push("spans"); }
    if (lists) { if (lists.length) props.lists = lists as unknown as Json; else remove.push("lists"); }
    updateNode(doc, t.id, props, remove);
    return;
  }
  const inst = findNode(doc, t.inst).node;
  const d = structuredClone((inst.descendants ?? {}) as Record<string, DocNode>);
  if (t.kind === "override") merge(d, t.key);
  else if (t.kind === "repOverride") {
    const rep = replacementsIn(d).get(t.rep);
    if (!rep) throw new TextEditError(404, "not_found", `no replacement "${t.rep}" in ${t.inst}`);
    merge((rep.descendants ??= {}) as Record<string, DocNode>, t.key);
  } else {
    const rep = replacementsIn(d).get(t.id);
    if (!rep) throw new TextEditError(404, "not_found", `no replacement "${t.id}" in ${t.inst}`);
    put(rep);
  }
  inst.descendants = d as unknown as Json;
}

/** `lists`: the paragraphs' list items (src/page/text-paras.js), when the edit sends them. */
export type TextBody = { file?: string; id?: string; content?: unknown; spans?: unknown; lists?: unknown; also?: unknown[]; expectedRevision?: string };

/** The lists an edit sends, checked against the new content's paragraphs; undefined when it sends none. */
function listsOf(b: TextBody, content: string): ListItem[] | undefined {
  if (b.lists === undefined) return undefined;
  const errs = listErrors(b.lists, paragraphCount(content));
  if (errs.length) throw new TextEditError(400, "invalid", errs[0]);
  return normalizeLists(b.lists, paragraphCount(content));
}
export type TextResult = { ok: true; id: string; changed: boolean; deleted?: boolean; revision?: string; select?: string[] };

/** Write one text edit and record one undo step. */
export async function editText(docFile: string, b: TextBody, who: { source: "user" | "mcp"; session?: string }): Promise<TextResult> {
  const id = typeof b.id === "string" ? b.id : "";
  if (!id) throw new TextEditError(400, "invalid", "id is required");
  if (typeof b.content !== "string") throw new TextEditError(400, "invalid", "content must be a string");
  if (b.content.length > MAX_TEXT) throw new TextEditError(413, "invalid", "that text is too long");
  const content = b.content.replace(/\r\n?/g, "\n");
  const doc = currentDoc(docFile).doc;
  // Multi-edit (several text layers selected, Return, type): `also` names the other layers that take the
  // same text, in the same step.
  const also = Array.isArray(b.also) ? [...new Set(b.also.filter((x): x is string => typeof x === "string" && x !== id))].slice(0, 500) : [];
  const resolve = (id: string) => {
    const t = textTarget(doc, id);
    if (!t) {
      // Nothing in the file holds that layer any more (deleted, or moved off while it was being typed in): say so,
      // instead of blaming a component that does not exist.
      if (!anchorExists(doc, id)) throw new TextEditError(404, "not_found", "that text was deleted");
      throw new TextEditError(409, "unsupported", "that text lives inside a component in a way Canvas cannot override; edit the component");
    }
    const drawn = drawnNode(doc, t, id);
    if (!drawn) throw new TextEditError(404, "not_found", "that text was deleted");
    if (!isTextLayer(drawn.type)) throw new TextEditError(400, "invalid", `"${id}" is a ${drawn.type}, not a text layer`);
    // Text bound to a string variable: writing the typed text would replace the binding with plain text.
    const bound = boundVariable(doc, drawn);
    if (bound) throw new TextEditError(409, "variable", `that text comes from the variable ${bound}; edit the variable instead`);
    return { id, t, drawn };
  };
  const { t, drawn } = resolve(id);
  const others = also.map(resolve);
  // Empty: the layer goes. One structure step, the same as Delete.
  if (content === "" && drawn.type === "text" && t.kind === "node" && others.every((o) => o.t.kind === "node" && o.drawn.type === "text")) {
    const r = await runStructure(docFile, { op: "delete", ids: [id, ...also], expectedRevision: b.expectedRevision }, who);
    return { ok: true, id, changed: true, deleted: true, revision: r.revision, select: r.select };
  }
  if (others.length) return editMany(docFile, b, [{ id, t, drawn }, ...others], content, who);
  // Styled ranges (src/page/text-spans.js), when the edit sends them: checked against the new content.
  let spans: Span[] | undefined;
  if (b.spans !== undefined) {
    const errs = spanErrors(b.spans, content.length);
    if (errs.length) throw new TextEditError(400, "invalid", errs[0]);
    spans = normalizeSpans(b.spans, content.length);
  }
  const sameSpans = spans === undefined || JSON.stringify(spans) === JSON.stringify(normalizeSpans(drawn.spans, content.length));
  const lists = listsOf(b, content);
  const sameLists = lists === undefined || JSON.stringify(lists) === JSON.stringify(normalizeLists(drawn.lists, paragraphCount(content)));
  if (typeof drawn.content === "string" && drawn.content === content && sameSpans && sameLists) return { ok: true, id, changed: false };
  const anchor = t.kind === "node" ? t.id : t.inst;
  let op: NodeOp | undefined;
  const { write } = await editDoc(docFile, { expectedRevision: b.expectedRevision, touches: [anchor] }, (d) => {
    // The change may run twice (a replay after an outside save); the last run is the one written.
    const before = propsOf(findNode(d, anchor).node);
    applyContent(d, t, content, spans, lists);
    op = nodeDiff(anchor, before, propsOf(findNode(d, anchor).node));
  });
  if (op && Object.keys(op.props).length) {
    // Never merged: two edits of the same layer a moment apart are two steps.
    record(docFile, [op], { label: "Edit Text", source: who.source, session: who.session, mergeKey: `text:${Date.now()}:${Math.random()}`, edit: write.edit, ...write.history }, write.revision);
  }
  return { ok: true, id, changed: true, revision: write.revision };
}

/** Multi-edit: the same content (and ranges, when sent) on every layer, one write, one undo step ("Edit Text"). */
async function editMany(docFile: string, b: TextBody, targets: { id: string; t: TextTarget; drawn: DocNode }[], content: string, who: { source: "user" | "mcp"; session?: string }): Promise<TextResult> {
  let spans: Span[] | undefined;
  if (b.spans !== undefined) {
    const errs = spanErrors(b.spans, content.length);
    if (errs.length) throw new TextEditError(400, "invalid", errs[0]);
    spans = normalizeSpans(b.spans, content.length);
  }
  const lists = listsOf(b, content);
  const anchors = [...new Set(targets.map((x) => (x.t.kind === "node" ? x.t.id : x.t.inst)))];
  const ops: NodeOp[] = [];
  const { write } = await editDoc(docFile, { expectedRevision: b.expectedRevision, touches: anchors }, (d) => {
    ops.length = 0;
    const before = new Map(anchors.map((a) => [a, propsOf(findNode(d, a).node)]));
    // The edited layer takes the ranges and lists the edit sent; each other one keeps its own styling, mapped to the
    // new text the way the editor maps a single edit (follow), never the edited layer's.
    for (const [i, x] of targets.entries()) {
      if (i === 0) { applyContent(d, x.t, content, spans, lists); continue; }
      const was = typeof x.drawn.content === "string" ? x.drawn.content : "";
      const own = Array.isArray(x.drawn.spans) ? normalizeSpans(followSpans(x.drawn.spans as unknown as Span[], was, content), content.length) : [];
      const ownLists = Array.isArray(x.drawn.lists) ? normalizeLists(followLists(x.drawn.lists, was, content), paragraphCount(content)) : [];
      applyContent(d, x.t, content, own, ownLists);
    }
    for (const a of anchors) ops.push(nodeDiff(a, before.get(a)!, propsOf(findNode(d, a).node)));
  });
  const real = ops.filter((op) => Object.keys(op.props).length);
  if (!real.length) return { ok: true, id: targets[0].id, changed: false };
  record(docFile, real, { label: "Edit Text", source: who.source, session: who.session, mergeKey: `text:${Date.now()}:${Math.random()}`, edit: write.edit, ...write.history }, write.revision);
  return { ok: true, id: targets[0].id, changed: true, revision: write.revision };
}

export type ReplaceBody = { file?: string; query?: unknown; replacement?: unknown; matchCase?: unknown; wholeWord?: unknown; only?: { id?: unknown; start?: unknown }; expectedRevision?: string };
export type ReplaceResult = { ok: true; replaced: number; layers: number; ids: string[]; revision?: string };

/**
 * Find and replace: every occurrence of `query` in every text layer of the file, on every page, or only
 * one (`only`: the layer and the offset the find bar shows). One write, one undo step ("Replace Text"). Styled
 * ranges follow (the new words take the style of the letter before them). Text bound to a variable is left alone;
 * text inside instances follows its component, so the component's text is what changes.
 */
export async function replaceText(docFile: string, b: ReplaceBody, who: { source: "user" | "mcp"; session?: string }): Promise<ReplaceResult> {
  const query = typeof b.query === "string" ? b.query : "";
  if (!query) throw new TextEditError(400, "invalid", "query is required");
  if (query.length > 500) throw new TextEditError(400, "invalid", "query is too long");
  if (typeof b.replacement !== "string") throw new TextEditError(400, "invalid", "replacement must be a string");
  const replacement = b.replacement.replace(/\r\n?/g, "\n");
  const o = { matchCase: b.matchCase === true, wholeWord: b.wholeWord === true };
  const doc = currentDoc(docFile).doc;
  const vars = doc.variables as Record<string, unknown> | undefined;
  const onlyId = b.only && typeof b.only.id === "string" ? b.only.id : null;
  const onlyAt = b.only && Number.isInteger(b.only.start) ? (b.only.start as number) : null;
  if (b.only && (onlyId === null || onlyAt === null)) throw new TextEditError(400, "invalid", "only needs { id, start }");
  const targets: { id: string; at: number[] }[] = [];
  walk(doc, (n) => {
    if (onlyId !== null && String(n.id) !== onlyId) return;
    const text = replaceableText(n, vars);
    if (text === null) return;
    let at = findAll(text, query, o, Infinity);
    if (onlyAt !== null) at = at.filter((s) => s === onlyAt);
    if (at.length) targets.push({ id: String(n.id), at });
  });
  if (onlyId !== null && !targets.length) throw new TextEditError(409, "stale_revision", "that match is gone: the text changed; find again");
  if (!targets.length) return { ok: true, replaced: 0, layers: 0, ids: [] };
  const ops: NodeOp[] = [];
  const { write } = await editDoc(docFile, { expectedRevision: b.expectedRevision, touches: targets.map((t) => t.id) }, (d) => {
    ops.length = 0;
    for (const t of targets) {
      const node = findNode(d, t.id).node;
      const before = propsOf(node);
      let text = String(node.content);
      let spans = Array.isArray(node.spans) ? (node.spans as Span[]) : null;
      // Right to left, so the offsets still to replace stay where they were.
      for (const s of [...t.at].sort((x, y) => y - x)) {
        text = text.slice(0, s) + replacement + text.slice(s + query.length);
        if (spans) spans = shiftSpans(spans, s, query.length, replacement.length);
      }
      if (text.length > MAX_TEXT) throw new TextEditError(413, "invalid", "the replaced text would be too long");
      updateNode(d, t.id, spans ? { content: text, spans: spans as unknown as Json } : { content: text });
      ops.push(nodeDiff(t.id, before, propsOf(node)));
    }
  });
  const real = ops.filter((op) => Object.keys(op.props).length);
  if (real.length) record(docFile, real, { label: "Replace Text", source: who.source, session: who.session, mergeKey: `replace:${Date.now()}:${Math.random()}`, edit: write.edit, ...write.history }, write.revision);
  return { ok: true, replaced: targets.reduce((s, t) => s + t.at.length, 0), layers: targets.length, ids: targets.map((t) => t.id), revision: write.revision };
}

export type TextDeps = {
  prime: (file: string) => Promise<void>;
  docFileOf: (file: string) => string;
  /** After a write: tell pages and the bridge. */
  written: (docFile: string, revision: string | undefined, by: "mcp" | "inspector", id: string, deleted: boolean) => void;
};

export async function handleTextRoute(req: http.IncomingMessage, res: http.ServerResponse, url: URL, deps: TextDeps): Promise<boolean> {
  if (url.pathname !== "/api/text" && url.pathname !== "/api/replace") return false;
  const reply = (status: number, v: unknown) => {
    res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" });
    res.end(JSON.stringify(v));
  };
  try {
    if (req.method !== "POST" || req.headers["x-canvas"] !== "1") return reply(403, { error: "forbidden", code: "forbidden" }), true;
    const raw = await readBodyText(req, MAX_TEXT * 6 + 10_000); // bytes: a control character escapes to 6 (\u0001)
  if (raw === null) return reply(413, { error: "too large", code: "invalid" }), true;
    const b = JSON.parse(raw || "{}") as TextBody;
    if (!b.file) return reply(400, { error: "file is required", code: "invalid" }), true;
    await deps.prime(b.file);
    const docFile = deps.docFileOf(b.file);
    const by = req.headers["x-canvas-source"] === "mcp" ? "mcp" : "inspector";
    const session = String(req.headers["x-canvas-session"] ?? "").slice(0, 80) || undefined;
    if (url.pathname === "/api/replace") {
      const r = await replaceText(docFile, b as ReplaceBody, { source: by === "mcp" ? "mcp" : "user", session });
      if (r.replaced) deps.written(docFile, r.revision, by, r.ids[0], false);
      return reply(200, r), true;
    }
    const r = await editText(docFile, b, { source: by === "mcp" ? "mcp" : "user", session });
    if (r.changed) deps.written(docFile, r.revision, by, r.id, !!r.deleted);
    return reply(200, r), true;
  } catch (e) {
    if (e instanceof TextEditError || e instanceof StructureError) return reply(e.status, { error: e.message, code: e.code }), true;
    if (e instanceof StaleFileError) return reply(409, { error: (e as Error).message, code: "stale_revision" }), true;
    if (e instanceof ValidationError) return reply(422, { error: (e as Error).message, code: "invalid" }), true;
    if (/no node with id/.test((e as Error).message)) return reply(404, { error: (e as Error).message, code: "not_found" }), true;
    return reply(422, { error: (e as Error).message, code: "failed" }), true;
  }
}
