// The text splice transform (decision 8): a `text` op was written against the text as of its `baseSeq`. The room
// moves it over the splices other actions applied to that layer since, when they do not overlap it. A whole write in
// between (a set of content, spans or lists, a splice that set spans or lists, an insert that brought the layer
// back), an overlap, or more than MAX_TEXT_EDITS splices: the op is refused as a conflict and the Mac keeps the
// person's text as a copy. The same functions record what an applied action did, on both sides.

import type { AppliedAction, DocNode, FileOp } from "./seam.ts";

export const MAX_TEXT_EDITS = 50;

/** What one applied op did to one text layer: a splice (from, del, ins characters) or a whole write. */
export type TextEdit = { node: string; seq: number; action: string; whole: boolean; from: number; del: number; ins: number };

type TextOp = Extract<FileOp, { k: "text" }>;
export type Transformed = { from: number; del: number } | { conflict: string };

/** `op` moved over `edits` (the layer's edits after op.baseSeq, in seq order). */
export function transformSplice(op: Pick<TextOp, "from" | "del" | "spans" | "lists">, edits: readonly TextEdit[]): Transformed {
  if (edits.length > MAX_TEXT_EDITS) return { conflict: `this text changed ${edits.length} times since; more than ${MAX_TEXT_EDITS}` };
  if (edits.length && (op.spans !== undefined || op.lists !== undefined)) return { conflict: "this text changed since, and the edit sets its styles whole" };
  let from = op.from;
  const del = op.del;
  for (const e of edits) {
    if (e.whole) return { conflict: "this text was replaced since" };
    if (e.from + e.del <= from) from += e.ins - e.del; // before ours (an insert at the same point goes first)
    else if (e.from >= from + del) continue; // after ours
    else return { conflict: "someone changed the same part of this text since" };
  }
  return { from, del };
}

const textNodes = (n: DocNode, out: string[]) => {
  if (typeof n.content === "string" && typeof n.id === "string") out.push(n.id);
  for (const c of Array.isArray(n.children) ? n.children : []) textNodes(c, out);
  return out;
};

/** The text edits an applied action made, one per op that touched a layer's text, at the op's own seq. */
export function textEditsOf(a: Pick<AppliedAction, "first" | "id" | "ops">): TextEdit[] {
  const out: TextEdit[] = [];
  a.ops.forEach((op, i) => {
    const seq = a.first + i;
    const whole = (node: string) => out.push({ node, seq, action: a.id, whole: true, from: 0, del: 0, ins: 0 });
    if (op.k === "text") {
      if (op.spans !== undefined || op.lists !== undefined) whole(op.id);
      else out.push({ node: op.id, seq, action: a.id, whole: false, from: op.from, del: op.del, ins: op.ins.length });
    } else if (op.k === "set") {
      if (["content", "spans", "lists"].some((k) => Object.hasOwn(op.props, k))) whole(op.id);
    } else if (op.k === "insert") {
      for (const id of textNodes(op.node as DocNode, [])) whole(id);
    }
  });
  return out;
}
