// QA scenarios for the shortcuts that had no real-key test: K (scale tool), Opt+Cmd+Shift+R (fit the board),
// Opt+Cmd+C / V (copy and paste properties), "." (repeat), Cmd+] / [ and Option (order), Opt+Cmd+K / B (component,
// detach), Cmd+Return (ask about the selection) and Shift+Cmd+Return (variations). Each key goes in as a real key
// press (Chrome's Input.dispatchKeyEvent) and the result is read from the file on disk or the page.
import { sc, type T } from "./harness.ts";
import { sleep } from "./lib.ts";

const until = async (t: T, ok: () => boolean, what: string) => {
  for (let i = 0; i < 60; i++) { await t.flush(); if (ok()) return; await sleep(100); }
  throw new Error(`timed out waiting for ${what}`);
};
const kids = (t: T, id: string) => (t.node(id)?.children ?? []).map((c: any) => c.id);

sc("keys", "K: the scale tool scales a frame with its children; Esc leaves it", { covers: ["scale-tool:keyboard", "scale-tool:frame"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["fr_outer"]);
  const w0 = t.node("fr_outer")!.width as number, iw0 = t.node("fr_inner")!.width as number;
  await t.io.key("k");
  await t.waitFor(`(() => { const b = document.getElementById("scaleBadge"); return !!b && b.style.display !== "none"; })()`, "the Scale badge");
  const r = await t.rect("fr_outer");
  await t.io.drag(r.x + r.w - 1, r.y + r.h - 1, r.x + r.w * 1.5, r.y + r.h * 1.5, { steps: 10 });
  await until(t, () => (t.node("fr_outer")!.width as number) > w0 * 1.3, "the frame scaled on disk");
  const k = (t.node("fr_outer")!.width as number) / w0;
  t.near((t.node("fr_inner")!.width as number) / iw0, k, 0.05, "the child scaled by the same factor");
  await t.io.key("Escape");
  await t.waitFor(`(() => { const b = document.getElementById("scaleBadge"); return !b || b.style.display === "none"; })()`, "the Scale badge gone");
});

sc("keys", "Opt+Cmd+Shift+R: the board shrinks to fit its content", { covers: ["fit-board:keyboard", "fit-board:board"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["lay_nest"]);
  // Room around the content first, so fitting has something to take away.
  await t.a.post("/api/update", { file: t.file, id: "lay_nest", props: { width: 2400, height: 1800 } });
  await until(t, () => t.node("lay_nest")!.width === 2400, "the board enlarged");
  await t.frames(4);
  await t.io.key("r", { alt: true, meta: true, shift: true });
  await until(t, () => (t.node("lay_nest")!.width as number) < 2400 && (t.node("lay_nest")!.height as number) < 1800, "the board fitted on disk");
});

sc("keys", "Opt+Cmd+C then Opt+Cmd+V: the fill goes from one layer to another", { covers: ["copy-paste-props:keyboard", "copy-paste-props:rectangle"] }, async (t: T) => {
  await t.focus("lay_nest");
  const want = JSON.stringify(t.node("r_g1")!.fill);
  t.ok(JSON.stringify(t.node("r_g2")!.fill) !== want, "the two start different");
  await t.select(["r_g1"]);
  await t.io.key("c", { alt: true, meta: true });
  await sleep(300);
  await t.select(["r_g2"]);
  await t.io.key("v", { alt: true, meta: true });
  await until(t, () => JSON.stringify(t.node("r_g2")!.fill) === want, "r_g2 took r_g1's fill");
});

sc("keys", ". repeats the last edit on another layer", { covers: ["repeat:keyboard", "repeat:one"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["r_g1"]);
  await t.io.key("5");
  await until(t, () => t.node("r_g1")!.opacity === 0.5, "r_g1 at 50% on disk");
  await t.select(["r_g2"]);
  await t.io.key(".");
  await until(t, () => t.node("r_g2")!.opacity === 0.5, "r_g2 at 50% after .");
});

sc("keys", "Cmd+] / Cmd+[ step a layer up and down; Option+Cmd+] / [ to the front and back", { covers: ["reorder:keyboard", "reorder:rectangle"] }, async (t: T) => {
  await t.focus("lay_nest");
  const start = kids(t, "lay_nest");
  const n = start.length;
  t.ok(start.indexOf("r_free") > 0, `r_free is not at the bottom (${start})`);
  await t.select(["r_free"]);
  const at = () => kids(t, "lay_nest").indexOf("r_free");
  const i0 = at();
  await t.io.key("[", { meta: true });
  await until(t, () => at() === i0 - 1, "one step back");
  await t.io.key("]", { meta: true });
  await until(t, () => at() === i0, "one step forward");
  await t.io.key("[", { meta: true, alt: true });
  await until(t, () => at() === 0, "to the back");
  await t.io.key("]", { meta: true, alt: true });
  await until(t, () => at() === n - 1, "to the front");
});

sc("keys", "Opt+Cmd+K makes a component; Opt+Cmd+B detaches an instance", { covers: ["create-component:keyboard", "create-component:frame", "create-component:instance"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["fr_outer"]);
  await t.io.key("k", { alt: true, meta: true });
  await until(t, () => t.node("fr_outer")!.reusable === true, "fr_outer is a component on disk");
  await t.focus("cmp_inst");
  await t.select(["inst_plain"]);
  t.eq(t.node("inst_plain")!.type, "ref", "inst_plain starts as an instance");
  await t.io.key("b", { alt: true, meta: true });
  await until(t, () => t.node("inst_plain")?.type !== "ref", "inst_plain detached on disk");
  t.eq(t.node("inst_plain")!.type, "frame", "a detached instance is a frame");
});

sc("keys", "Cmd+Return opens the composer on the selection", { covers: ["talk-to-selection:keyboard", "talk-to-selection:one"] }, async (t: T) => {
  await t.focus("lay_nest");
  await t.select(["r_free"]);
  await t.io.key("Enter", { meta: true });
  await t.waitFor(`(() => { const c = document.querySelector(".sk-comp"); return !!c && getComputedStyle(c).display !== "none" && c.getBoundingClientRect().width > 0; })()`, "the composer open");
  t.eq(await t.sel(), ["r_free"], "the selection stays");
});

sc("keys", "Shift+Cmd+Return asks for variations of the selected board", { covers: ["variations:keyboard", "variations:board"] }, async (t: T) => {
  await t.focus("lay_nest");
  // The request is caught before it reaches an agent: this checks the key, not the agent run.
  await t.ev(`(() => { const f = window.fetch; window.__vars = []; window.fetch = (u, o) => { if (String(u).includes("/api/variations/make")) { window.__vars.push(JSON.parse(o.body)); return Promise.resolve(new Response(JSON.stringify({ error: "qa" }), { status: 400 })); } return f(u, o); }; })()`);
  await t.select(["lay_nest"]);
  await t.io.key("Enter", { meta: true, shift: true });
  const got = await t.waitFor<any[]>(`window.__vars.length ? window.__vars : null`, "a variations request");
  t.eq(got[0].ids, ["lay_nest"], "for the selected board");
});
