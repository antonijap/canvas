// pnpm qa:matrix: scenarios generated from the catalog's edits and the playground's node types (docs/qa-plan.md
// section 3). Every edit (move, resize from each edge and corner, the common properties, group, ungroup, auto layout
// on and off, duplicate, delete, copy and paste) on every node type in the playground, each one followed by the
// shared checks (undo to the original bytes, redo to the end bytes, save and reopen, file, console, selection,
// overlay UI, the end-state picture against qa/baselines/matrix). Then seeded random sequences of those edits
// (property-based): the base seed is printed; QA_SEED=<seed> replays the same sequences, and
// QA_SEED=<seed> pnpm qa:matrix "seed <n>" one of them.
import { loadCatalog } from "./catalog.ts";
import { Fail, scenarios, type AnyNode, type Rect, type Scenario, type T } from "./harness.ts";
import { sleep, type Mods } from "./lib.ts";
// @ts-ignore: the page's own plain ES module
import { unrotatedSize } from "../src/page/geometry.js";

const cat = loadCatalog();
/** Only pairs the catalog has: a generated scenario never claims a case its feature does not list. */
const pairs = (xs: string[]) => [...new Set(xs)].filter((p) => { const i = p.indexOf(":"); return cat.byId.get(p.slice(0, i))?.cases.includes(p.slice(i + 1)); });

// ---------------------------------------------------------------- targets

type Target = { kind: "layer"; case: string; id: string; board: string } | { kind: "card"; case: string; widget: string };
const LAYERS: Target[] = [
  { kind: "layer", case: "rectangle", id: "r_free", board: "lay_nest" },
  { kind: "layer", case: "ellipse", id: "rz_ell", board: "lay_resize" },
  { kind: "layer", case: "frame", id: "rz_frame", board: "lay_resize" },
  { kind: "layer", case: "group", id: "rz_group", board: "lay_resize" },
  { kind: "layer", case: "text", id: "rz_text", board: "lay_resize" },
  { kind: "layer", case: "image", id: "rz_img", board: "lay_resize" },
  { kind: "layer", case: "instance", id: "rz_inst", board: "lay_resize" },
  { kind: "layer", case: "rotated", id: "rz_rot", board: "lay_resize" },
  { kind: "layer", case: "in-autolayout", id: "al_b", board: "lay_auto" },
  { kind: "layer", case: "in-frame", id: "fp_a", board: "lay_auto" },
  { kind: "layer", case: "nested", id: "r_n3", board: "lay_nest" },
];
const CARDS: Target[] = ["todo", "note", "posthog", "shader", "video"].map((k) => ({ kind: "card", case: `card-${k}`, widget: k }));
const AUTO_ROW: Target = { kind: "layer", case: "frame", id: "al_row", board: "lay_auto" };

const HANDLES = ["n", "s", "e", "w", "ne", "nw", "se", "sw"] as const;
type Handle = (typeof HANDLES)[number];

// ---------------------------------------------------------------- page helpers

const nodeOf = (t: T, id: string) => t.node(id);
const count = (t: T) => { let n = 0; const w = (x: AnyNode) => { n++; (x.children ?? []).forEach(w); }; t.disk().children.forEach(w); return n; };
const boardOf = (t: T, id: string): string | null => { const doc = t.disk(); for (const b of doc.children) if (b.id === id || JSON.stringify(b).includes(`"id":"${id}"`)) return b.id!; return null; };

async function worldRect(t: T, id: string): Promise<Rect | null> {
  return id.startsWith("widget:")
    ? t.ev(`(() => { const r = window.canvasHost.widgetRect && window.canvasHost.widgetRect(${JSON.stringify(id)}); return r ? { x: r.x, y: r.y, w: r.w, h: r.h } : null; })()`)
    : t.ev(`window.canvasHost.worldRectOf(${JSON.stringify(id)})`);
}
/** The picture frame: the target before and after the edit, with room around it (small baselines). */
async function frameAround(t: T, id: string, before: Rect | null) {
  await t.settle().catch(() => {});
  const after = await worldRect(t, id).catch(() => null);
  const rs = [before, after].filter(Boolean) as Rect[];
  if (!rs.length) return;
  const m = 40, x0 = Math.min(...rs.map((r) => r.x)) - m, y0 = Math.min(...rs.map((r) => r.y)) - m;
  t.subjectRect = { x: x0, y: y0, w: Math.max(...rs.map((r) => r.x + r.w)) + m - x0, h: Math.max(...rs.map((r) => r.y + r.h)) + m - y0 };
}

async function showLayer(t: T, id: string) {
  const b = boardOf(t, id);
  if (!b) throw new Fail(`${id} is not in the file`);
  await t.focus(b);
}
async function selectLayer(t: T, id: string) {
  await t.select([id]);
  await t.frames(3);
  const sel = await t.sel();
  if (sel.length !== 1 || sel[0] !== id) throw new Fail(`could not select ${id} (selection ${JSON.stringify(sel)})`);
}
async function cardRect(t: T, kind: string): Promise<{ w: any; r: Rect; id: string }> {
  const w = t.widgets().widgets.find((x: any) => x.kind === kind);
  if (!w) throw new Fail(`no ${kind} card`);
  const r = await t.ev<Rect | null>(`(() => { const e = document.querySelector('.wd[data-id="widget:${w.id}"]'); if (!e) return null; const b = e.getBoundingClientRect(); return { x: b.left, y: b.top, w: b.width, h: b.height }; })()`);
  if (!r) throw new Fail(`card ${w.id} is not on the page`);
  return { w, r, id: "widget:" + w.id };
}
async function showCard(t: T, kind: string) {
  await t.showPage("cards");
  const w = t.widgets().widgets.find((x: any) => x.kind === kind);
  if (!w) throw new Fail(`no ${kind} card`);
  await t.look(w.x - 20, w.y - 40, 1, 40);
  await t.waitFor(`!!document.querySelector('.wd[data-id="widget:${w.id}"] .wd-body > *')`, "the card to mount");
  await t.frames(4);
}
async function key(t: T, k: string, mods: Mods = {}) { await t.io.key(k, mods); await t.waitHistory(); }

/** A layer's turn on the canvas (its own rotation plus its parents'), and its own size on screen; null when upright. */
async function turnOf(t: T, id: string): Promise<{ deg: number; w: number; h: number } | null> {
  let deg = 0;
  for (let at: string | null = id; at; at = t.parentOf(at)) deg += Number(t.node(at)?.rotation) || 0;
  if (!(deg % 180)) return null;
  const n = t.node(id)!, box = (await t.selBox())!, z = await t.ev<number>("window.canvasHost.cam.z");
  const own = unrotatedSize(box.w, box.h, deg, typeof n.width === "number" ? n.width * z : undefined, typeof n.height === "number" ? n.height * z : undefined);
  return own ? { deg, w: own.w, h: own.h } : null;
}

async function pullHandle(t: T, h: Handle, d = 24, turn: { deg: number; w: number; h: number } | null = null) {
  const box = await t.selBox();
  if (!box) throw new Fail("no selection box to pull");
  const sx = h.includes("w") ? -1 : h.includes("e") ? 1 : 0, sy = h.includes("n") ? -1 : h.includes("s") ? 1 : 0;
  let px = box.x + box.w / 2 + (sx * box.w) / 2, py = box.y + box.h / 2 + (sy * box.h) / 2;
  let dx = sx * d, dy = sy * d;
  if (turn) {
    // A turned layer's handles sit on its own edges and corners (the box is axis-aligned): along its axes.
    const a = (-turn.deg * Math.PI) / 180, c = { x: box.x + box.w / 2, y: box.y + box.h / 2 };
    const along = (lx: number, ly: number) => ({ x: lx * Math.cos(a) - ly * Math.sin(a), y: lx * Math.sin(a) + ly * Math.cos(a) });
    const p = along((sx * turn.w) / 2, (sy * turn.h) / 2), v = along(sx * d, sy * d);
    px = c.x + p.x; py = c.y + p.y; dx = v.x; dy = v.y;
  }
  await t.io.move(px - dx / 4, py - dy / 4);
  await sleep(300);
  await t.io.move(px, py);
  await t.frames(2);
  await t.io.drag(px, py, px + dx, py + dy, { steps: 8 });
  await t.flush();
  await t.settle();
}

/**
 * A point on the card's side or corner `h` (screen rect r) that a press reaches: the card itself is under it, or, at a
 * corner, the selection box's corner handle. The middle of the side first, then along it; null when other cards cover
 * all of it.
 */
async function grabPoint(t: T, id: string, r: Rect, h: Handle): Promise<{ x: number; y: number } | null> {
  const sx = h.includes("w") ? -1 : h.includes("e") ? 1 : 0, sy = h.includes("n") ? -1 : h.includes("s") ? 1 : 0;
  const edgeX = (ins: number) => (sx < 0 ? r.x + ins : r.x + r.w - ins), edgeY = (ins: number) => (sy < 0 ? r.y + ins : r.y + r.h - ins);
  const pts: { x: number; y: number }[] = [];
  if (sx && sy) for (const [a, b] of [[5, 5], [5, 9], [9, 5]]) pts.push({ x: edgeX(a), y: edgeY(b) });
  else {
    // Along the side, clear of the corner zones (twice the 6 px band, src/page/geometry.js resizeZone).
    const len = sx ? r.h : r.w, offs = [];
    for (let o = 14; o <= len - 14; o += 8) offs.push(o);
    offs.sort((a, b) => Math.abs(a - len / 2) - Math.abs(b - len / 2));
    for (const o of offs) pts.push(sx ? { x: edgeX(3), y: r.y + o } : { x: r.x + o, y: edgeY(3) });
  }
  return t.ev(`(() => {
    for (const p of ${JSON.stringify(pts)}) {
      const e = document.elementFromPoint(p.x, p.y);
      if (!e) continue;
      const card = e.closest(".wd");
      if ((card && card.dataset.id === ${JSON.stringify(id)}) || ${sx && sy ? "!!e.closest('#sel.wsel i')" : "false"}) return p;
    }
    return null;
  })()`);
}

// ---------------------------------------------------------------- edits

type Edit = {
  name: string;
  features: string[];
  /** Which targets it makes sense on. */
  on: (x: Target) => boolean;
  /** Do it (the target is shown and selected); answer what is wrong with the result, or nothing. */
  run: (t: T, x: Target) => Promise<string | void>;
};
const layer = (x: Target): x is Extract<Target, { kind: "layer" }> => x.kind === "layer";
const NUMBER_POS = new Set(["rectangle", "ellipse", "frame", "group", "text", "image", "instance", "rotated", "in-frame", "nested"]);
const FILLS = new Set(["rectangle", "ellipse", "frame", "text", "instance", "rotated", "in-autolayout", "in-frame", "nested"]);
const RADIUS = new Set(["rectangle", "frame", "instance", "rotated", "in-autolayout", "in-frame", "nested"]);

function propEdit(name: string, features: string[], on: (x: Target) => boolean, props: Record<string, unknown>, check: (n: AnyNode) => boolean): Edit {
  return {
    name, features, on,
    run: async (t, x) => {
      if (!layer(x)) return;
      // The inspector's write (POST /api/update), as the native panel sends it, while the layer is selected.
      await t.a.post("/api/update", { file: t.file, id: x.id, props });
      await t.waitHistory();
      const n = nodeOf(t, x.id);
      if (!n || !check(n)) return `${name}: ${x.id} is ${JSON.stringify(n && Object.fromEntries(Object.keys(props).map((k) => [k, n[k]])))}`;
    },
  };
}

const EDITS: Edit[] = [
  {
    name: "move", features: ["move"], on: () => true,
    run: async (t, x) => {
      if (layer(x)) {
        const n0 = nodeOf(t, x.id)!;
        const c = await t.center(x.id);
        // Control turns snapping off; in an auto layout flow it would take the layer out, and a flow does not snap.
        await t.measureWrites("move", () => t.io.drag(c.x, c.y, c.x + 37, c.y + 23, { late: inFlow(t, x.id) ? {} : { ctrl: true } }));
        const n1 = nodeOf(t, x.id);
        if (!n1) return `move: ${x.id} is gone`;
        if (!inFlow(t, x.id) && typeof n0.x === "number" && (Math.abs(n1.x - n0.x - 37) > 0.5 || Math.abs(n1.y - n0.y - 23) > 0.5)) return `move: ${x.id} at ${n1.x},${n1.y}, want ${n0.x + 37},${n0.y + 23}`;
      } else {
        const { w, r } = await cardRect(t, x.widget);
        await t.measureWrites("move", () => t.io.drag(r.x + r.w / 2, r.y + 14, r.x + r.w / 2 + 37, r.y + 14 + 23, { late: { ctrl: true } }));
        const w1 = t.widgets().widgets.find((y: any) => y.id === w.id);
        if (w1.x !== w.x + 37 || w1.y !== w.y + 23) return `move: card at ${w1.x},${w1.y}, want ${w.x + 37},${w.y + 23}`;
      }
    },
  },
  ...HANDLES.map((h): Edit => ({
    name: `resize ${h}`, features: ["resize", `resize:handle-${h}`], on: () => true,
    run: async (t, x) => {
      if (layer(x)) {
        const before = await t.rect(x.id);
        const turn = await turnOf(t, x.id);
        await pullHandle(t, h, 24, turn);
        const after = await t.rect(x.id);
        const grew = Math.abs(after.w - before.w) + Math.abs(after.h - before.h) >= 4;
        if (turn) return grew ? undefined : `resize ${h}: the drawn size did not change (turned ${turn.deg} degrees)`;
        // In an auto layout flow the layer's place comes from the flow (its own, or that of the groups it sits in up to
        // the first frame): it grows, its sides move where the flow puts them.
        if (placedByFlow(t, x.id)) {
          const n = t.node(x.id)!;
          const want = { w: h.includes("e") || h.includes("w"), h: h.includes("n") || h.includes("s") };
          if ((Math.abs(after.w - before.w) > 4) !== want.w || (Math.abs(after.h - before.h) > 4) !== want.h) return `resize ${h} in auto layout: ${round(before.w)}x${round(before.h)} -> ${round(after.w)}x${round(after.h)} (${n.width} x ${n.height})`;
          return;
        }
        const a = { l: before.x, t: before.y, r: before.x + before.w, b: before.y + before.h }, b = { l: after.x, t: after.y, r: after.x + after.w, b: after.y + after.h };
        const bad = (["l", "r", "t", "b"] as const).filter((k) => (Math.abs(b[k] - a[k]) > 4) !== ({ l: h.includes("w"), r: h.includes("e"), t: h.includes("n"), b: h.includes("s") })[k]);
        if (bad.length) return `resize ${h}: sides ${bad.join(", ")} wrong (${JSON.stringify(a)} -> ${JSON.stringify(b)})`;
      } else {
        const { w, r, id } = await cardRect(t, x.widget);
        const at = await grabPoint(t, id, r, h);
        // An earlier step in a random sequence can leave another card over this side (a note grown over the to-do's
        // right edge): a press there lands on the card on top, for a person too. Nothing to pull.
        if (!at) { t.note(`resize ${h}: the ${x.widget} card's ${h} side is under another card`); return; }
        const { x: px, y: py } = at;
        await t.io.move(px, py);
        await t.frames(2);
        await t.io.drag(px, py, px + (h.includes("w") ? -30 : h.includes("e") ? 30 : 0), py + (h.includes("n") ? -24 : h.includes("s") ? 24 : 0), { steps: 8 });
        await t.flush();
        const w1 = t.widgets().widgets.find((y: any) => y.id === w.id);
        if (w1.w === w.w && w1.h === w.h) return `resize ${h}: the card is still ${w.w} x ${w.h}`;
      }
    },
  })),
  { name: "opacity 5", features: ["opacity-keys", "opacity-keys:keyboard"], on: layer, run: async (t, x) => { if (!layer(x)) return; await key(t, "5"); const o = nodeOf(t, x.id)?.opacity; if (o !== 0.5) return `opacity: ${o}`; } },
  { name: "flip Shift+H", features: ["flip", "flip:keyboard"], on: layer, run: async (t, x) => { if (!layer(x)) return; const s0 = JSON.stringify(nodeOf(t, x.id)); await key(t, "H", { shift: true }); if (JSON.stringify(nodeOf(t, x.id)) === s0) return "flip: nothing changed"; } },
  // A toggle: a hidden layer (an earlier step in a random sequence) shows again.
  { name: "hide Shift+Cmd+H", features: ["hide-show", "hide-show:keyboard"], on: layer, run: async (t, x) => { if (!layer(x)) return; const was = nodeOf(t, x.id)?.enabled === false; await key(t, "h", { meta: true, shift: true }); const now = nodeOf(t, x.id)?.enabled === false; if (now === was) return `hide: still ${now ? "hidden" : "shown"}`; } },
  {
    name: "nudge right", features: ["nudge", "nudge:keyboard"], on: layer,
    run: async (t, x) => { if (!layer(x)) return; const n0 = nodeOf(t, x.id)!, r0 = await worldRect(t, x.id); await key(t, "ArrowRight"); const n1 = nodeOf(t, x.id)!; if (!inFlow(t, x.id) && typeof n0.x === "number" && n1.x !== n0.x + 1 && !(await drawnMoved(t, x.id, r0, 1, 0))) return `nudge: x ${n0.x} -> ${n1.x}`; },
  },
  {
    name: "big nudge down", features: ["nudge", "nudge:keyboard"], on: (x) => layer(x) && NUMBER_POS.has(x.case),
    run: async (t, x) => { if (!layer(x)) return; const n0 = nodeOf(t, x.id)!, r0 = await worldRect(t, x.id); await key(t, "ArrowDown", { shift: true }); const n1 = nodeOf(t, x.id)!; if (!inFlow(t, x.id) && typeof n0.y === "number" && n1.y !== n0.y + 10 && !(await drawnMoved(t, x.id, r0, 0, 10))) return `big nudge: y ${n0.y} -> ${n1.y}`; },
  },
  {
    // Groups have no width of their own: Cmd+arrows say "Could not resize" on them (not supported, see docs/qa-plan.md).
    name: "Cmd+Right widens", features: ["resize-keys", "resize-keys:keyboard"], on: (x) => layer(x) && x.case !== "group",
    run: async (t, x) => {
      if (!layer(x)) return;
      const n0 = nodeOf(t, x.id)!, r0 = await t.rect(x.id);
      await key(t, "ArrowRight", { meta: true });
      await t.settle();
      const n1 = nodeOf(t, x.id)!, r1 = await t.rect(x.id);
      if (typeof n0.width === "number") { if (n1.width !== n0.width + 1) return `Cmd+Right: width ${n0.width} -> ${n1.width}`; }
      else if (!(await turnOf(t, x.id)) && Math.abs(r1.w - r0.w - 1) > 0.6) return `Cmd+Right: drawn width ${r0.w} -> ${r1.w}`;
    },
  },
  propEdit("fill", ["set-props"], (x) => layer(x) && FILLS.has(x.case), { fill: "#2F855A" }, (n) => n.fill === "#2F855A"),
  propEdit("corner radius", ["set-props"], (x) => layer(x) && RADIUS.has(x.case), { cornerRadius: 9 }, (n) => n.cornerRadius === 9),
  propEdit("rotation", ["set-props", "rotate"], (x) => layer(x) && x.case !== "in-autolayout", { rotation: 15 }, (n) => n.rotation === 15),
  propEdit("rename", ["set-props"], layer, { name: "QA renamed" }, (n) => n.name === "QA renamed"),
  {
    name: "group Cmd+G", features: ["group", "group:keyboard"], on: layer,
    run: async (t, x) => { if (!layer(x)) return; const p0 = t.parentOf(x.id); await key(t, "g", { meta: true }); const p = t.parentOf(x.id); if (!p || p === p0 || nodeOf(t, p)?.type !== "group") return `group: ${x.id}'s parent is ${p} (${nodeOf(t, p ?? "")?.type})`; },
  },
  {
    name: "ungroup Shift+Cmd+G", features: ["ungroup", "ungroup:keyboard"], on: (x) => layer(x) && (x.case === "group" || x.case === "frame"),
    run: async (t, x) => { if (!layer(x)) return; const kids = (nodeOf(t, x.id)!.children ?? []).map((c) => c.id!); await key(t, "g", { meta: true, shift: true }); if (nodeOf(t, x.id)) return `ungroup: ${x.id} is still there`; const lost = kids.filter((k) => !nodeOf(t, k)); if (lost.length) return `ungroup: lost ${lost.join(", ")}`; },
  },
  {
    name: "auto layout Shift+A", features: ["autolayout-toggle", "autolayout-toggle:keyboard"], on: layer,
    run: async (t, x) => { if (!layer(x)) return; const s0 = JSON.stringify(t.disk()); await key(t, "A", { shift: true }); if (JSON.stringify(t.disk()) === s0) return "Shift+A changed nothing"; },
  },
  {
    // Cards do not duplicate (the page says so): layers only.
    name: "duplicate Cmd+D", features: ["duplicate", "duplicate:keyboard"], on: layer,
    run: async (t, x) => {
      if (layer(x)) { const n0 = count(t); await key(t, "d", { meta: true }); const n = count(t) - n0, want = 1 + subtree(nodeOf(t, x.id)!) - 1; if (n !== subtree(nodeOf(t, x.id)!)) return `duplicate: ${n} layers more, want ${want}`; }
    },
  },
  {
    name: "delete", features: ["delete", "delete:keyboard"], on: () => true,
    run: async (t, x) => {
      const card = layer(x) ? null : (await cardRect(t, x.widget)).w.id;
      await key(t, "Backspace");
      if (layer(x)) { if (nodeOf(t, x.id)) return `delete: ${x.id} is still there`; }
      else if (t.widgets().widgets.some((w: any) => w.id === card)) return "delete: the card is still there";
    },
  },
  {
    name: "copy and paste", features: ["copy-paste", "copy-paste:keyboard"], on: layer,
    run: async (t, x) => { if (!layer(x)) return; const n0 = count(t); await key(t, "c", { meta: true }); await key(t, "v", { meta: true }); if (count(t) <= n0) return "paste: no new layers"; },
  },
];
/**
 * The layer is drawn (dx, dy) from r0. The only child of a group keeps x 0, y 0 when nudged: the group fits itself to
 * its child and moves instead (an earlier Cmd+G in a random sequence).
 */
const drawnMoved = async (t: T, id: string, r0: Rect | null, dx: number, dy: number) => {
  const r1 = await worldRect(t, id);
  return !!r0 && !!r1 && Math.abs(r1.x - r0.x - dx) < 0.01 && Math.abs(r1.y - r0.y - dy) < 0.01 && Math.abs(r1.w - r0.w) < 0.01 && Math.abs(r1.h - r0.h) < 0.01;
};
/** The layer sits in an auto layout flow: the flow places it, it has no x or y of its own. */
const inFlow = (t: T, id: string) => { const p = t.parentOf(id), pn = p ? t.node(p) : null; return !!pn && pn.type === "frame" && pn.layout !== "none" && t.node(id)?.layoutPosition !== "absolute"; };
/** The flow places the layer, or a group it sits in before the first frame up. */
const placedByFlow = (t: T, id: string): boolean => {
  for (let at: string | null = id; at; at = t.parentOf(at)) {
    if (inFlow(t, at)) return true;
    const p = t.parentOf(at);
    if (!p || t.node(p)?.type !== "group") return false;
  }
  return false;
};
const round = (n: number) => Math.round(n * 10) / 10;
const subtree = (n: AnyNode): number => 1 + (n.children ?? []).reduce((s, c) => s + subtree(c), 0);

const AL_OFF: Edit = {
  name: "auto layout off Option+Shift+A", features: ["autolayout-toggle", "autolayout-toggle:keyboard"], on: () => true,
  run: async (t, x) => { if (!layer(x)) return; await key(t, "A", { shift: true, alt: true }); if (nodeOf(t, x.id)?.layout !== "none") return `layout is ${nodeOf(t, x.id)?.layout}`; },
};

// ---------------------------------------------------------------- one edit on one target

async function prepare(t: T, x: Target): Promise<Rect | null> {
  if (layer(x)) {
    await showLayer(t, x.id);
    await selectLayer(t, x.id);
    // An earlier step of a random sequence may have hidden it: a hidden layer is not drawn, so a pointer edit has
    // nothing to grab. Show it again first, the way a person would.
    if (nodeOf(t, x.id)?.enabled === false) {
      await key(t, "h", { meta: true, shift: true });
      await t.frames(3);
      if (nodeOf(t, x.id)?.enabled === false) throw new Fail(`${x.id} stays hidden after Shift+Cmd+H`);
    }
    return worldRect(t, x.id);
  }
  await showCard(t, x.widget);
  const { r, id } = await cardRect(t, x.widget);
  await t.io.click(r.x + r.w / 2, r.y + 14);
  await t.frames(3);
  const sel = await t.sel();
  if (sel[0] !== id) throw new Fail(`clicking the ${x.widget} card's title did not select it (${JSON.stringify(sel)})`);
  return worldRect(t, id);
}

function coversOf(e: Edit, x: Target): string[] {
  const out: string[] = [];
  for (const f of e.features) out.push(f.includes(":") ? f : `${f}:${x.case}`);
  if (x.kind === "card") {
    if (e.name === "move") out.push(`card-move:${x.case}`, "card-move:mouse");
    if (e.name.startsWith("resize ")) out.push(`card-resize:${x.case}`, `card-resize:handle-${e.name.slice(7)}`, "card-resize:mouse");
  }
  if (e.name === "move" || e.name.startsWith("resize ")) out.push(`${e.features[0]}:mouse`);
  out.push(`undo-redo:${x.case}`, `save-reopen:${x.case}`, "file-integrity:tiny", `selection-post:${x.case}`);
  return pairs(out);
}

function register(e: Edit, x: Target, label = x.case) {
  scenarios.push({
    kind: "matrix", area: `matrix ${label}`, name: e.name, covers: coversOf(e, x),
    run: async (t) => {
      const before = await prepare(t, x);
      const why = await e.run(t, x);
      await t.flush();
      await frameAround(t, layer(x) ? x.id : "widget:" + t.widgets().widgets.find((w: any) => w.kind === x.widget)?.id, before);
      if (why) throw new Fail(why);
    },
  });
}

for (const x of [...LAYERS, ...CARDS]) for (const e of EDITS) if (e.on(x)) register(e, x);
register(AL_OFF, AUTO_ROW, "auto layout row");

// ---------------------------------------------------------------- random sequences

/** mulberry32: a small seeded generator, so a sequence replays exactly from its seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let x = Math.imul(a ^ (a >>> 15), 1 | a); x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x; return ((x ^ (x >>> 14)) >>> 0) / 4294967296; };
}

const RANDOM_COUNT = Number(process.env.QA_RANDOM) || 24, STEPS = 6;
const base = Number(process.env.QA_SEED) || 0;
if (base) {
  const simple = EDITS;
  for (let i = 0; i < RANDOM_COUNT; i++) {
    const seed = base + i;
    scenarios.push({
      kind: "matrix", area: "matrix random", name: `seed ${seed}`,
      covers: pairs(["undo-redo:many", "file-integrity:tiny", "undo-redo:keyboard"]),
      // A random end state has no stored picture; the live and reopened pictures are still compared.
      skip: { visual: "a random sequence's end state has no baseline (the live and reopened pictures are compared)" },
      run: async (t) => {
        const r = rng(seed);
        const done: string[] = [];
        for (let k = 0; k < STEPS; k++) {
          // Targets still in the file (an earlier step may have deleted or grouped one away).
          const doc = JSON.stringify(t.disk());
          const live = [...LAYERS, ...CARDS].filter((x) => (layer(x) ? doc.includes(`"id":"${x.id}"`) : t.widgets().widgets.some((w: any) => w.kind === x.widget)));
          const x = live[Math.floor(r() * live.length)];
          const options = simple.filter((e) => e.on(x));
          const e = options[Math.floor(r() * options.length)];
          done.push(`${e.name} on ${layer(x) ? x.id : x.widget}`);
          try {
            await prepare(t, x);
            const why = await e.run(t, x);
            await t.flush();
            // A step that does not do what it says is a finding, not noise: the sequence stops there.
            if (why) throw new Fail(why);
          } catch (err) {
            throw new Fail(`step ${k + 1} (${done.at(-1)}): ${(err as Error).message}\n  steps: ${done.join("; ")}\n  replay: QA_SEED=${base} pnpm qa:matrix "seed ${seed}"`);
          }
          await sleep(20);
        }
        t.note(`steps: ${done.join("; ")}`);
      },
    } satisfies Scenario);
  }
}
