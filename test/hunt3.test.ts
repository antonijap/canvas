// Regression tests for Codex bug hunt round 3 (.planning/research/codex-hunt-3.md), the findings a pure module
// can show: live-edit acknowledgements and held gestures, the video sound rule, group/ungroup of absolutely
// placed layers, and images on a paste from another document.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-ignore: a plain ES module the page imports too
import * as L from "../src/page/live-edit.js";
// @ts-ignore: a plain ES module the page imports too
import { soundOn } from "../src/page/videos.js";
import { groupNodes, rebaseAssets, ungroupNodes } from "../src/structure.ts";

const scene = (props: Record<string, unknown>): any => ({ root: { id: "B", children: [{ id: "N", ...props }] } });

describe("codex hunt 3: page", () => {
  test("b5 a page resize answering does not settle an inspector write still in flight on the same node", () => {
    let t = 0;
    const e = new L.LiveEdits({ now: () => t });
    e.set("B", "N", { fill: "#FF0000" }, [], 1); // the shell's write #1, in flight
    e.set("B", "N", { width: 140 }, [], L.PAGE_OPS + 1); // the page's resize write
    t = 10;
    e.ack("N", L.PAGE_OPS + 1, true);
    assert.equal(e.pending("B"), true, "the fill write has not answered");
    const s = scene({ fill: "#000000", width: 100 });
    e.rebase("B", s, 20);
    assert.equal(s.root.children[0].fill, "#FF0000", "the pending fill stays drawn");
    e.ack("N", 1, true);
    assert.equal(e.pending("B"), false);
    assert.equal(L.covers(5, 3), true);
    assert.equal(L.covers(L.PAGE_OPS + 5, 3), false);
    assert.equal(L.covers(5, L.PAGE_OPS + 1), false);
  });

  test("b6 a resize side dragged back to where it started loses its earlier preview", () => {
    const e = new L.LiveEdits({ now: () => 0 });
    e.set("B", "N", { width: 140, height: 120 }, [], 0);
    // back to 100 wide: the writes hold only height now
    e.unset("B", "N", ["width"], 0);
    e.set("B", "N", { height: 130 }, [], 0);
    const s = scene({ width: 100, height: 100 });
    e.apply("B", s);
    assert.deepEqual([s.root.children[0].width, s.root.children[0].height], [100, 130]);
    // an inspector write of the same key is not the gesture's to drop
    e.set("B", "N", { width: 300 }, [], 7);
    e.unset("B", "N", ["width"], 0);
    const s2 = scene({ width: 100 });
    e.apply("B", s2);
    assert.equal(s2.root.children[0].width, 300);
  });

  test("b7 a resize or scale held still keeps its preview past PREVIEW_MS; an abandoned one lets go", () => {
    let t = 0;
    const e = new L.LiveEdits({ now: () => t });
    e.set("B", "N", { width: 140 }, [], 0);
    for (t = 250; t <= L.PREVIEW_MS * 3; t += 250) {
      e.touch("B"); // the gesture is held: live.js touches its board every expiry tick
      assert.deepEqual(e.expire(), []);
    }
    assert.equal(e.size, 1);
    t += L.PREVIEW_MS + 1;
    assert.deepEqual(e.expire(), ["B"], "let go once nothing holds it");
  });

  test("b8 Mute silences a card whose setting is muted:false; Unmute gives sound to a muted card", () => {
    assert.equal(soundOn(true, null, false), true, "pressed play, the card says unmuted");
    assert.equal(soundOn(true, false, false), false, "then Mute");
    assert.equal(soundOn(true, true, true), true, "Unmute on a muted card");
    assert.equal(soundOn(true, null, undefined), false, "muted by default");
    assert.equal(soundOn(false, true, false), false, "autoplay and hover stay silent");
  });
});

describe("codex hunt 3: structure", () => {
  const doc = () => ({
    children: [
      { type: "frame", id: "B", x: 0, y: 0, width: 400, height: 300, layout: "horizontal", children: [
        { type: "rectangle", id: "Flow", width: 20, height: 20 },
        { type: "rectangle", id: "Abs", x: 100, y: 80, width: 30, height: 30, layoutPosition: "absolute" },
        { type: "frame", id: "Wrap", x: 100, y: 80, width: 60, height: 60, layout: "none", layoutPosition: "absolute", children: [
          { type: "rectangle", id: "In", x: 10, y: 20, width: 10, height: 10, layoutPosition: "absolute" },
        ] },
      ] },
    ],
  }) as any;
  const find = (d: any, id: string): any => { const seek = (ns: any[]): any => { for (const n of ns ?? []) { if (n.id === id) return n; const h = seek(n.children); if (h) return h; } }; return seek(d.children); };

  test("c4 grouping an absolutely placed layer in auto layout keeps it where it was", () => {
    const d = doc();
    const r = groupNodes(d, ["Abs"]);
    const g = find(d, r.select[0]);
    assert.equal(g.layoutPosition, "absolute");
    assert.deepEqual([g.x, g.y], [100, 80]);
    assert.deepEqual([find(d, "Abs").x, find(d, "Abs").y], [0, 0], "inside the group, at its origin");
  });

  test("c5 ungrouping an absolute frame in auto layout moves its absolute children by the frame's offset", () => {
    const d = doc();
    ungroupNodes(d, ["Wrap"]);
    const n = find(d, "In");
    assert.equal(n.layoutPosition, "absolute");
    assert.deepEqual([n.x, n.y], [110, 100]);
  });

  test("c6 a paste from another document keeps its images: relative urls become the source's files", () => {
    const n = { id: "R", type: "rectangle", fill: { type: "image", url: "media/photo.png" }, children: [{ id: "S", fills: [{ type: "image", url: "../x.png" }, { type: "image", url: "https://e.com/a.png" }] }] } as any;
    rebaseAssets(n, "/a/design.canvas.json", "/b/design.canvas.json");
    assert.equal(n.fill.url, "/a/media/photo.png");
    assert.equal(n.children[0].fills[0].url, "/x.png");
    assert.equal(n.children[0].fills[1].url, "https://e.com/a.png");
    const same = { fill: { type: "image", url: "media/p.png" } } as any;
    rebaseAssets(same, "/a/one.canvas.json", "/a/two.canvas.json");
    assert.equal(same.fill.url, "media/p.png", "same folder: unchanged");
  });
});
