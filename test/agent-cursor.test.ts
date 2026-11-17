// The agent cursor: what an MCP edit shows as (src/agent-cursor.ts), the "agentedit" event pages get, and the
// page's queue and timing (src/page/agent-cursor-logic.js): legible one at a time, faster in a burst, never more
// than about a second behind, a fade after two idle seconds, no glide under reduce motion.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { agentLabel, cursorActions, MAX_ACTIONS } from "../src/agent-cursor.ts";
import type { Op } from "../src/history.ts";
import { tmpDir } from "./helpers.ts";
// @ts-ignore: a browser module without types
import * as L from "../src/page/agent-cursor-logic.js";

const v = (x: unknown) => ({ v: x as any });

describe("what an MCP edit shows as", () => {
  test("x/y is a move with its change; width/height a resize; content a caret; the rest a click", () => {
    const ops: Op[] = [
      { t: "node", id: "a", props: { x: { b: v(10), a: v(40) }, y: { b: v(0), a: v(-5) } } },
      { t: "node", id: "b", props: { width: { b: v(100), a: v(150) } } },
      { t: "node", id: "c", props: { content: { b: v("Hi"), a: v("Hello") } } },
      { t: "node", id: "d", props: { fill: { b: v("#fff"), a: v("#000") } } },
    ];
    assert.deepEqual(cursorActions(ops), [
      { kind: "move", id: "a", dx: 30, dy: -5 },
      { kind: "resize", id: "b", dx: 0, dy: 0, dw: 50, dh: 0 },
      { kind: "text", id: "c" },
      { kind: "edit", id: "d" },
    ]);
  });
  test("a width that becomes Fill (no number) is a click, not a resize", () => {
    assert.deepEqual(cursorActions([{ t: "node", id: "a", props: { width: { b: v(100), a: v("fill_container") } } }]), [{ kind: "edit", id: "a" }]);
  });
  test("a new layer carries its box; a removed one is a delete; cards are widget ids", () => {
    const node = { type: "frame", id: "N1", x: 5, y: 6, width: 70, height: 80 } as any;
    assert.deepEqual(cursorActions([{ t: "tree", kind: "insert", parent: null, index: 0, node }]), [{ kind: "add", id: "N1", parent: null, box: { x: 5, y: 6, w: 70, h: 80 } }]);
    assert.deepEqual(cursorActions([{ t: "tree", kind: "remove", parent: "B", index: 0, node }]), [{ kind: "delete", id: "N1" }]);
    assert.deepEqual(cursorActions([{ t: "widget", id: "w1", b: null, a: {} as any, bi: -1, ai: 0 }]), [{ kind: "add", id: "widget:w1", parent: null, box: null }]);
  });
  test("a big edit shows on its first few layers only, each once", () => {
    const ops: Op[] = Array.from({ length: 40 }, (_, i) => ({ t: "node", id: "n" + i, props: { opacity: { b: v(1), a: v(0.5) } } }) as Op);
    assert.equal(cursorActions(ops).length, MAX_ACTIONS);
    assert.equal(cursorActions([ops[0], ops[0]]).length, 1);
  });
  test("the tag names the agent from its MCP client", () => {
    assert.equal(agentLabel("claude-code"), "Claude");
    assert.equal(agentLabel("codex-mcp-client"), "Codex");
    assert.equal(agentLabel("zed-editor"), "Zed");
    assert.equal(agentLabel(""), "Agent");
    assert.equal(agentLabel(undefined), "Agent");
  });
});

describe("the page's queue and timing", () => {
  test("one edit plays at its full time, divided by the speed setting", () => {
    assert.deepEqual(L.timing(1, 1, false), { glide: L.GLIDE_MS, act: L.ACT_MS });
    const fast = L.timing(1, L.SPEEDS.fast, false);
    assert.ok(fast.glide < L.GLIDE_MS && fast.act < L.ACT_MS);
    assert.ok(L.GLIDE_MS >= 250 && L.GLIDE_MS <= 400, "a glide of 250 to 400 ms");
  });
  test("a backlog speeds up so all of it fits in the lag budget", () => {
    for (const n of [2, 3, 5]) {
      const t = L.timing(n, 1, false);
      assert.ok(n * (t.glide + t.act) <= L.MAX_LAG_MS + 1, `${n} edits play within a second`);
    }
  });
  test("a draining backlog keeps its tempo: the last edits do not slow down and blow the budget", () => {
    // Six edits arrive at t=0; each starts when the one before ends, with what is left of the second.
    let now = 120, total = 0;
    for (let pending = 6; pending >= 1; pending--) {
      const t = L.timing(pending, 1, false, 1000 - now);
      total += t.glide + t.act;
      now += t.glide + t.act;
    }
    assert.ok(now <= 1000 + 1, `caught up by ${Math.round(now)} ms`);
  });
  test("a single edit with time to spare plays at its full time", () => {
    assert.deepEqual(L.timing(1, 1, false, 880), { glide: L.GLIDE_MS, act: L.ACT_MS });
  });
  test("more than fits even at the fastest: the oldest are dropped", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ id: "n" + i, kind: "edit", agent: "Claude" }));
    const kept = L.trimQueue(items, 1);
    assert.ok(kept.length < 50 && kept.length >= 1);
    assert.equal(kept[kept.length - 1].id, "n49", "the newest stays");
    const t = L.timing(kept.length, 1, false);
    assert.ok(kept.length * (t.glide + t.act) <= L.MAX_LAG_MS + 1, "what is left plays within the lag budget");
  });
  test("an edit playing when a burst arrives speeds up from where it is, never slows down", () => {
    const play = { start: 0, glide: 300, act: 300 };
    const t = L.timing(6, 1, false);
    const r = L.retime(play, 300, t);
    assert.equal(r.glide + r.act, t.glide + t.act);
    assert.ok(Math.abs((300 - r.start) / (r.glide + r.act) - 0.5) < 1e-9, "still half way through");
    assert.deepEqual(L.retime(play, 300, { glide: 400, act: 400 }), play);
  });
  test("nudges of one layer play as one drag; a click then a click on another layer stay two", () => {
    const q = L.coalesce([
      { id: "a", kind: "move", dx: 1, dy: 0, agent: "Claude", r0: { x: 0, y: 0, w: 10, h: 10 } },
      { id: "a", kind: "move", dx: 1, dy: 2, agent: "Claude", r0: { x: 1, y: 0, w: 10, h: 10 } },
      { id: "b", kind: "edit", agent: "Claude" },
      { id: "a", kind: "edit", agent: "Claude" },
    ]);
    assert.equal(q.length, 3);
    assert.equal(q[0].dx, 2);
    assert.equal(q[0].dy, 2);
    assert.deepEqual(q[0].r0, { x: 0, y: 0, w: 10, h: 10 }, "the box from before the first nudge");
  });
  test("reduce motion: no glide, the cursor jumps", () => {
    assert.equal(L.timing(1, 1, true).glide, 0);
    const f = L.frameAt("edit", { x: 0, y: 0 }, { anchor: { x: 100, y: 100 }, end: { x: 100, y: 100 } }, 0, 200, 0);
    assert.equal(f.phase, "act");
    assert.deepEqual([f.x, f.y], [100, 100]);
  });
  test("glide eases to the anchor, then a move drags to its end", () => {
    const pts = { anchor: { x: 100, y: 0 }, end: { x: 200, y: 0 } };
    assert.equal(L.frameAt("move", { x: 0, y: 0 }, pts, 300, 300, 0).x, 0);
    const mid = L.frameAt("move", { x: 0, y: 0 }, pts, 300, 300, 150);
    assert.equal(mid.phase, "glide");
    assert.equal(mid.x, 50, "eased: half way at half time");
    assert.ok(L.frameAt("move", { x: 0, y: 0 }, pts, 300, 300, 60).x < 20, "slow start");
    const act = L.frameAt("move", { x: 0, y: 0 }, pts, 300, 300, 450);
    assert.equal(act.phase, "act");
    assert.equal(act.x, 150);
    const click = L.frameAt("edit", { x: 0, y: 0 }, { anchor: { x: 100, y: 0 }, end: { x: 100, y: 0 } }, 300, 300, 450);
    assert.equal(click.x, 100, "a click stays put");
    assert.equal(L.frameAt("move", { x: 0, y: 0 }, pts, 300, 300, 700).phase, "done");
  });
  test("where a moved layer was: from the box read on arrival, whether or not the canvas had caught up", () => {
    const before = { x: 0, y: 0, w: 10, h: 10 }, afterBox = { x: 30, y: 5, w: 10, h: 10 }, d = { dx: 30, dy: 5 };
    assert.deepEqual(L.spanOf(before, afterBox, d), { from: before, to: afterBox }, "read before the change");
    assert.deepEqual(L.spanOf(afterBox, afterBox, d), { from: before, to: afterBox }, "the canvas had changed already");
    assert.deepEqual(L.spanOf(null, afterBox, d), { from: before, to: afterBox });
    const r = L.spanOf({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 30, h: 10 }, { dw: 20 });
    assert.deepEqual(L.actPoints("resize", null, r), { anchor: { x: 10, y: 10 }, end: { x: 30, y: 10 } }, "a resize drags the corner");
  });
  test("a new layer draws in from its top-left corner; text shows a caret at its end", () => {
    const box = { x: 10, y: 20, w: 100, h: 40 };
    assert.deepEqual(L.actPoints("add", box, null), { anchor: { x: 10, y: 20 }, end: { x: 110, y: 60 } });
    assert.deepEqual(L.ghostAt("add", null, box, 0.5), { x: 10, y: 20, w: 50, h: 20 });
    assert.deepEqual(L.actPoints("text", box, null).anchor, { x: 110, y: 40 });
  });
  test("idle: full for two seconds after the last edit, then fades out", () => {
    assert.equal(L.idleOpacity(0), 1);
    assert.equal(L.idleOpacity(L.IDLE_MS), 1);
    assert.ok(L.idleOpacity(L.IDLE_MS + L.FADE_MS / 2) > 0 && L.idleOpacity(L.IDLE_MS + L.FADE_MS / 2) < 1);
    assert.equal(L.idleOpacity(L.IDLE_MS + L.FADE_MS), 0);
  });
  test("follows pan and zoom: world to screen", () => {
    assert.deepEqual(L.toScreen({ x: 100, y: 50 }, { x: -20, y: 10, z: 2 }), { x: 180, y: 110 });
  });
});

describe("the agentedit event", () => {
  const dir = tmpDir("agentcursor");
  process.env.CANVAS_ROOTS = dir;
  const docFile = path.join(dir, "cursor.canvas.json");
  fs.writeFileSync(docFile, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "B1", name: "Board", x: 0, y: 0, width: 390, height: 844, layout: "none", children: [
    { type: "rectangle", id: "R1", x: 10, y: 20, width: 50, height: 50, fill: "#FF0000" },
  ] }] }, null, 2));
  const file = fs.realpathSync(docFile);
  let server: any;
  after(() => {
    fs.unwatchFile(file);
    server?.closeAllConnections();
    server?.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("an MCP edit reaches the page's stream as what it did, named after the agent; a person's edit does not", async () => {
    const { startServer } = await import("../src/server.ts");
    server = await startServer(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const ac = new AbortController();
    const r = await fetch(`${base}/events?file=${encodeURIComponent(file)}`, { signal: ac.signal });
    const reader = r.body!.getReader();
    let text = "";
    const read = async (until: (t: string) => boolean, ms = 3000) => {
      const end = Date.now() + ms;
      while (!until(text) && Date.now() < end) {
        const chunk = await Promise.race([reader.read(), new Promise<null>((res) => setTimeout(() => res(null), 200))]);
        if (chunk && chunk.value) text += new TextDecoder().decode(chunk.value);
      }
    };
    await read((t) => t.includes("event: doc"));
    const post = (headers: Record<string, string>, props: Record<string, unknown>) =>
      fetch(`${base}/api/update`, { method: "POST", headers: { "x-canvas": "1", "content-type": "application/json", ...headers }, body: JSON.stringify({ file, id: "R1", props }) }).then((x) => x.json());
    await post({}, { fill: "#00FF00" });
    await post({ "x-canvas-source": "mcp", "x-canvas-session": "mcp-test-1", "x-canvas-agent": "claude-code" }, { x: 40 });
    await read((t) => t.includes("event: agentedit"));
    ac.abort();
    const events = text.split("\n\n").filter((b) => b.startsWith("event: agentedit"));
    assert.equal(events.length, 1, "only the agent's edit");
    const data = JSON.parse(events[0].split("\ndata: ")[1]);
    assert.equal(data.agent, "Claude");
    assert.equal(data.session, "mcp-test-1");
    assert.deepEqual(data.actions, [{ kind: "move", id: "R1", dx: 30, dy: 0 }]);
  });
});
