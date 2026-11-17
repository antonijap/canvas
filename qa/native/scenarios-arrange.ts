// Native scenarios for align, distribute and tidy up on several layers (apps/macos/Inspector.swift ArrangeSection,
// Library.swift right-click > Align, ShellLogic.swift ArrangeActions): the inspector's Arrange row shows for two or
// more, each button is one undo step, right-click > Align runs the same actions, and layers an auto layout frame
// places leave the row off. The page does the moving (src/page/shortcuts.js, smart.js).
import fs from "node:fs";
import path from "node:path";
import { center, NT, sc } from "./harness.ts";
import { ROOT } from "../lib.ts";

/** The Arrange row's button for `op` (align-left, distribute-h, tidy...), found by its .qaID mark. */
async function button(t: NT, op: string) {
  const st = await t.state();
  return t.mark({ id: "arrange", label: op, region: { x: st.window.width - 380, y: 60, w: 380, h: st.window.height - 60 } });
}
const xs = (t: NT, ids: string[]) => ids.map((id) => t.node(id)?.x);
const ys = (t: NT, ids: string[]) => ids.map((id) => t.node(id)?.y);
async function undo(t: NT) { await t.key("z", ["cmd"]); }
/** Undo selects what it put back (maybe only some of them): select all three again. */
async function reselect(t: NT, ids: string[]) {
  await t.selectIds(ids);
  await t.waitState((s) => s.selection && s.selection.ids?.length === ids.length, `${ids.length} selected again`);
}

sc("inspector", "arrange: the Arrange row aligns, distributes and tidies several layers, each one undo step", { covers: ["align-distribute:inspector", "align-distribute:many", "align-distribute:undo", "tidy-up:inspector"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.look(0, 0);
  const ids = ["fr_outer", "g_pair", "r_free"];
  const x0 = xs(t, ids), y0 = ys(t, ids);
  // One layer: no Arrange row.
  await t.selectIds(["r_free"]);
  t.eq((await t.marks({ id: "arrange" })).length, 0, "no Arrange row for one layer");
  await t.selectIds(ids);
  await t.waitState((s) => s.selection && s.selection.ids?.length === 3, "three selected");
  await button(t, "align-left");
  fs.mkdirSync(path.join(ROOT, "qa", "out", "native"), { recursive: true });
  await t.shot(path.join(ROOT, "qa", "out", "native", "arrange-row.png"));
  // Every action from the row, its result checked on the drawn rects, then one Undo puts all three back.
  const box = (rs: { x: number; y: number; w: number; h: number }[]) => ({ l: Math.min(...rs.map((r) => r.x)), t: Math.min(...rs.map((r) => r.y)), r: Math.max(...rs.map((r) => r.x + r.w)), b: Math.max(...rs.map((r) => r.y + r.h)) });
  const gaps = (rs: { x: number; y: number; w: number; h: number }[], a: "x" | "y") => {
    const s = a === "x" ? "w" : "h", o = rs.slice().sort((p, q) => p[a] - q[a]);
    return o.slice(1).map((r, i) => r[a] - (o[i][a] + o[i][s]));
  };
  const before = await Promise.all(ids.map((id) => t.rect(id)));
  const b0 = box(before);
  const tol = 2; // window points at 100%
  const checks: Record<string, (rs: typeof before) => boolean> = {
    "align-left": (rs) => rs.every((r) => Math.abs(r.x - b0.l) < tol),
    "align-hcenter": (rs) => rs.every((r) => Math.abs(r.x + r.w / 2 - (b0.l + b0.r) / 2) < tol),
    "align-right": (rs) => rs.every((r) => Math.abs(r.x + r.w - b0.r) < tol),
    "align-top": (rs) => rs.every((r) => Math.abs(r.y - b0.t) < tol),
    "align-vcenter": (rs) => rs.every((r) => Math.abs(r.y + r.h / 2 - (b0.t + b0.b) / 2) < tol),
    "align-bottom": (rs) => rs.every((r) => Math.abs(r.y + r.h - b0.b) < tol),
    "distribute-h": (rs) => { const g = gaps(rs, "x"); return Math.abs(g[0] - g[1]) < tol; },
    "distribute-v": (rs) => { const g = gaps(rs, "y"); return Math.abs(g[0] - g[1]) < tol; },
    "tidy": (rs) => { const b = box(rs); return Math.abs(b.l - b0.l) < tol && Math.abs(b.t - b0.t) < tol; },
  };
  for (const [op, ok] of Object.entries(checks)) {
    await t.click(center(await button(t, op)));
    await t.waitDisk(() => JSON.stringify([xs(t, ids), ys(t, ids)]) !== JSON.stringify([x0, y0]), `${op} moved a layer`);
    await t.settle(4000).catch(() => {});
    const rs = await Promise.all(ids.map((id) => t.rect(id)));
    t.ok(ok(rs), `${op}: ${JSON.stringify(rs)} from ${JSON.stringify(before)}`);
    await undo(t);
    await t.waitDisk(() => JSON.stringify([xs(t, ids), ys(t, ids)]) === JSON.stringify([x0, y0]), `one Undo after ${op}`);
    await reselect(t, ids);
  }
});

sc("inspector", "arrange: right-click > Align runs the same actions; layers auto layout places turn the row off", { covers: ["align-distribute:context-menu", "align-distribute:in-autolayout", "tidy-up:context-menu"] }, async (t: NT) => {
  await t.showPage("layout");
  await t.look(0, 0);
  const ids = ["fr_outer", "g_pair", "r_free"];
  const x0 = xs(t, ids);
  await t.selectIds(ids);
  await t.waitState((s) => s.selection && s.selection.ids?.length === 3, "three selected");
  const r = await t.rect("r_free");
  await t.click(center(r), { right: true });
  const items = (await t.cmd("qa.menu", { sub: "Align" })).items as { title: string; enabled: boolean; key: string }[];
  t.eq(items.map((i) => i.title), ["Align left", "Align horizontal centers", "Align right", "Align top", "Align vertical centers", "Align bottom", "Distribute horizontal spacing", "Distribute vertical spacing", "Tidy up"], "the Align submenu");
  t.ok(items.every((i) => i.enabled), "all on for three free layers");
  await t.pickMenu("Align > Align right");
  const right = Math.max(...(await Promise.all(ids.map((id) => t.rect(id)))).map((q) => q.x + q.w));
  await t.waitDisk(() => JSON.stringify(xs(t, ids)) !== JSON.stringify(x0), "align right moved them");
  const after = await Promise.all(ids.map((id) => t.rect(id)));
  t.ok(after.every((q) => Math.abs(q.x + q.w - right) < 2), "right edges line up");
  await undo(t);
  await t.waitDisk(() => JSON.stringify(xs(t, ids)) === JSON.stringify(x0), "one Undo");
  // Three layers an auto layout row places: the row is off and says why; right-click > Align is off too.
  await t.showPage("layout");
  await t.look(640, 0);
  await t.selectIds(["al_a", "al_b", "al_c"]);
  const st = await t.waitState((s) => s.selection && s.selection.ids?.length === 3 && s.selection.free === 0, "the shell knows none of them move");
  t.ok(st.selection.free === 0, "free 0");
  await t.waitText("Auto layout places these layers", { x: st.window.width - 380, y: 60, w: 380, h: st.window.height - 60 });
  const before = xs(t, ["al_a", "al_b", "al_c"]);
  await t.click(center(await button(t, "align-left")));
  await t.click(center(await t.rect("al_b")), { right: true });
  const off = (await t.cmd("qa.menu", { sub: "Align" })).items as { title: string; enabled: boolean }[];
  t.ok(off.every((i) => !i.enabled), `every Align item off: ${JSON.stringify(off)}`);
  await t.cmd("qa.menu", { cancel: true }).catch(() => {});
  t.eq(xs(t, ["al_a", "al_b", "al_c"]), before, "nothing moved");
});
