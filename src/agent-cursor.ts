// The agent cursor (src/page/agent-cursor.js): what an agent's edit through Canvas MCP did, in the terms the page
// draws it. Each history record an MCP session makes (src/history.ts, source "mcp") becomes a short list of actions:
// a move or a resize (with the change, so the page can drag along it), a text edit, a new layer (its box, drawn in),
// a delete, or any other property change (a click on the layer). The page gets them as the "agentedit" event on the
// document's stream, before the change itself arrives as a diff, so it can read where the layer was.

import type { Op } from "./history.ts";

export type Box = { x: number; y: number; w: number; h: number };
export type CursorAction =
  | { kind: "move"; id: string; dx: number; dy: number }
  | { kind: "resize"; id: string; dx: number; dy: number; dw: number; dh: number }
  | { kind: "text"; id: string }
  | { kind: "add"; id: string; parent: string | null; box: Box | null }
  | { kind: "delete"; id: string }
  | { kind: "edit"; id: string };

/** At most this many actions per record: a scale of 200 layers is shown on the first few, not 200 glides. */
export const MAX_ACTIONS = 6;

const num = (v: { v: unknown } | null | undefined): number | null => (v && typeof v.v === "number" && Number.isFinite(v.v) ? v.v : null);
const delta = (p: { b: { v: unknown } | null; a: { v: unknown } | null } | undefined): number => {
  if (!p) return 0;
  const b = num(p.b), a = num(p.a);
  return a !== null && b !== null ? a - b : 0;
};
const boxOf = (n: Record<string, unknown>): Box | null => {
  const x = n.x, y = n.y, w = n.width, h = n.height;
  return typeof x === "number" && typeof y === "number" && typeof w === "number" && typeof h === "number" ? { x, y, w, h } : null;
};

/** The actions one recorded edit shows as, in the order they were made, at most `max`. */
export function cursorActions(ops: Op[], max = MAX_ACTIONS): CursorAction[] {
  const out: CursorAction[] = [];
  const seen = new Set<string>();
  const add = (a: CursorAction) => {
    const key = a.kind + ":" + a.id;
    if (seen.has(key) || out.length >= max) return;
    seen.add(key);
    out.push(a);
  };
  for (const op of ops) {
    if (out.length >= max) break;
    if (op.t === "node") {
      const keys = Object.keys(op.props);
      const has = (k: string) => keys.includes(k);
      if (has("content")) add({ kind: "text", id: op.id });
      else if (has("width") || has("height")) {
        const dw = delta(op.props.width), dh = delta(op.props.height);
        add(dw || dh ? { kind: "resize", id: op.id, dx: delta(op.props.x), dy: delta(op.props.y), dw, dh } : { kind: "edit", id: op.id });
      } else if (has("x") || has("y")) {
        const dx = delta(op.props.x), dy = delta(op.props.y);
        add(dx || dy ? { kind: "move", id: op.id, dx, dy } : { kind: "edit", id: op.id });
      } else add({ kind: "edit", id: op.id });
    } else if (op.t === "tree") {
      const id = typeof op.node?.id === "string" ? op.node.id : "";
      if (!id) continue;
      if (op.kind === "insert") add({ kind: "add", id, parent: op.parent, box: boxOf(op.node as Record<string, unknown>) });
      else add({ kind: "delete", id });
    } else if (op.t === "move") add({ kind: "edit", id: op.id });
    else if (op.t === "widget") {
      const id = "widget:" + op.id;
      if (!op.b && op.a) add({ kind: "add", id, parent: null, box: null });
      else if (op.b && !op.a) add({ kind: "delete", id });
      else add({ kind: "edit", id });
    }
  }
  return out;
}

/**
 * The name on the cursor's tag, from the MCP client's own name (its `initialize` clientInfo, sent as
 * x-canvas-agent): Claude Code is "Claude", Codex is "Codex", anything else its first word, capitalised.
 */
export function agentLabel(client: string | undefined | null): string {
  const s = String(client ?? "").trim().toLowerCase();
  if (!s) return "Agent";
  if (s.includes("claude")) return "Claude";
  if (s.includes("codex")) return "Codex";
  if (s.includes("cursor")) return "Cursor";
  const word = s.split(/[^a-z0-9]+/).find(Boolean) ?? "";
  return word ? (word[0].toUpperCase() + word.slice(1)).slice(0, 16) : "Agent";
}
