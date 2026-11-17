// The canvas page script's pure helpers (src/pagelogic.ts): the page embeds these same functions.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fitCam, keepLabels, overlayNode, pickPage, retryDelay, unionRect, wheelAction, zoomAt } from "../src/pagelogic.ts";

describe("zoomAt (pinch zoom keeps the point under the pointer)", () => {
  test("the anchor is in view px: the world point under it stays under it", () => {
    const cam = { x: -300, y: 120, z: 0.5 };
    // The view starts 200 px into the window (left rail): window x 600 is view x 400.
    const ax = 600 - 200, ay = 300;
    const before = { x: (ax - cam.x) / cam.z, y: (ay - cam.y) / cam.z };
    const c = zoomAt(cam, ax, ay, 1);
    assert.deepEqual({ x: before.x * c.z + c.x, y: before.y * c.z + c.y }, { x: ax, y: ay });
    // Feeding window px instead (the bug) puts the world point 200 px off at 2x.
    const wrong = zoomAt(cam, 600, ay, 1);
    assert.equal(Math.abs(before.x * wrong.z + wrong.x - ax), 200);
  });
});

describe("wheelAction (sweep S5: Cmd+scroll zooms)", () => {
  const ev = (o: Partial<Parameters<typeof wheelAction>[0]>) => ({ deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...o });
  test("Cmd+scroll zooms: up (negative deltaY) in, down out", () => {
    const up = wheelAction(ev({ deltaY: -30, metaKey: true }));
    const down = wheelAction(ev({ deltaY: 30, metaKey: true }));
    assert.ok("zoom" in up && up.zoom > 1, JSON.stringify(up));
    assert.ok("zoom" in down && down.zoom < 1, JSON.stringify(down));
  });
  test("a wheel event that lost its Command flag still zooms while the shell says Command is down", () => {
    const a = wheelAction(ev({ deltaY: -30 }), true);
    assert.ok("zoom" in a && a.zoom > 1);
  });
  test("pinch (WebKit's Ctrl+wheel) still zooms", () => {
    const a = wheelAction(ev({ deltaY: -10, ctrlKey: true }));
    assert.ok("zoom" in a && a.zoom > 1);
  });
  test("plain scroll pans both ways; Shift+wheel pans sideways; a trackpad's own sideways motion is kept", () => {
    assert.deepEqual(wheelAction(ev({ deltaX: 5, deltaY: 12 })), { dx: 5, dy: 12 });
    assert.deepEqual(wheelAction(ev({ deltaY: 12, shiftKey: true })), { dx: 12, dy: 0 });
    assert.deepEqual(wheelAction(ev({ deltaX: 7, deltaY: 1, shiftKey: true })), { dx: 7, dy: 1 });
    assert.deepEqual(wheelAction(ev({ deltaY: 3, deltaMode: 1 })), { dx: 0, dy: 48 });
  });
  test("the zoom keeps the point under the pointer (with zoomAt)", () => {
    const cam = { x: 100, y: 50, z: 1 };
    const a = wheelAction(ev({ deltaY: -50, metaKey: true }));
    assert.ok("zoom" in a);
    const c = zoomAt(cam, 700, 400, cam.z * a.zoom);
    const before = { x: (700 - cam.x) / cam.z, y: (400 - cam.y) / cam.z };
    assert.ok(Math.abs(before.x * c.z + c.x - 700) < 1e-9 && Math.abs(before.y * c.z + c.y - 400) < 1e-9);
  });
});

describe("fitCam (sweep S3: Fit page keeps clear of the islands)", () => {
  // The shell's islands in a 1560 x 980 window: rail + 244 panel on the left, the inspector on the right,
  // toolbar on top, zoom pill at the bottom (apps/macos ShellLogic CanvasInsets).
  const ins = { l: 314, t: 60, r: 304, b: 60 };
  const screen = (r: { x: number; y: number; w: number; h: number }, c: { x: number; y: number; z: number }) =>
    ({ x: r.x * c.z + c.x, y: r.y * c.z + c.y, w: r.w * c.z, h: r.h * c.z });
  for (const [name, r] of [
    ["wide page", { x: -2000, y: 300, w: 9000, h: 2400 }],
    ["tall page", { x: 0, y: 0, w: 800, h: 12000 }],
    ["one small board", { x: 40, y: 40, w: 300, h: 200 }],
  ] as const) {
    test(`${name}: inside the free area with the padding, centered`, () => {
      const c = fitCam(r, 1560, 980, ins, 70, 1);
      const s = screen(r, c);
      const free = { x: ins.l, y: ins.t, w: 1560 - ins.l - ins.r, h: 980 - ins.t - ins.b };
      assert.ok(s.x >= free.x + 70 - 1e-6 && s.y >= free.y + 70 - 1e-6, `top-left ${JSON.stringify(s)}`);
      assert.ok(s.x + s.w <= free.x + free.w - 70 + 1e-6 && s.y + s.h <= free.y + free.h - 70 + 1e-6, `bottom-right ${JSON.stringify(s)}`);
      assert.ok(Math.abs(s.x + s.w / 2 - (free.x + free.w / 2)) < 1e-6 && Math.abs(s.y + s.h / 2 - (free.y + free.h / 2)) < 1e-6, "centered");
    });
  }
  test("a narrow window shrinks the padding instead of spilling under the islands", () => {
    const r = { x: 0, y: 0, w: 1000, h: 1000 };
    const c = fitCam(r, 720, 420, ins, 70, 1);
    const s = screen(r, c);
    assert.ok(s.x >= ins.l && s.x + s.w <= 720 - ins.r + 1e-6 && s.y >= ins.t && s.y + s.h <= 420 - ins.b + 1e-6, JSON.stringify(s));
  });
});

describe("pickPage (which page shows; the remembered one is never lost)", () => {
  test("first load: the remembered page waits while only the stand-in list is known, then opens", () => {
    let st = pickPage(["page-1"], "proposal", "proposal");
    assert.deepEqual(st, { page: "page-1", want: "proposal" });
    st = pickPage(["final", "proposal"], st.page, st.want);
    assert.deepEqual(st, { page: "proposal", want: null });
  });
  test("a page list that arrives without the page shown (sidecar mid-rewrite) does not lose it", () => {
    let st = pickPage([], "proposal", null);
    // resolvePages turns an empty list into the implicit first page.
    st = pickPage(["page-1"], "proposal", null);
    assert.deepEqual(st, { page: "page-1", want: "proposal" });
    st = pickPage(["final", "proposal", "design-system"], st.page, st.want);
    assert.deepEqual(st, { page: "proposal", want: null });
  });
  test("the page shown stays; a page that is really gone falls back to the first and is still wanted", () => {
    assert.deepEqual(pickPage(["final", "proposal"], "final", null), { page: "final", want: null });
    assert.deepEqual(pickPage(["final"], "proposal", null), { page: "final", want: "proposal" });
    assert.deepEqual(pickPage(["final"], null, null), { page: "final", want: null });
  });
});

describe("retryDelay", () => {
  test("doubles from 1 s, at most 30 s", () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(retryDelay), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

describe("keepLabels (title collisions in screen buckets)", () => {
  const brute = (cands: { x: number; y: number; w: number; g: number }[], h: number) => {
    const kept: { x: number; y: number; w: number }[] = [];
    return cands.map((r) => {
      const ok = !kept.some((k) => r.x < k.x + k.w + r.g && k.x < r.x + r.w + r.g && r.y < k.y + h + r.g && k.y < r.y + h + r.g);
      if (ok) kept.push(r);
      return ok;
    });
  };
  test("same answer as comparing every pair", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let round = 0; round < 20; round++) {
      const cands = Array.from({ length: 400 }, () => ({ x: rnd() * 3000 - 200, y: rnd() * 1800 - 100, w: 20 + rnd() * 300, g: rnd() < 0.5 ? 2 : 8 }));
      assert.deepEqual(keepLabels(cands, 16), brute(cands, 16));
    }
  });
  test("thousands of titles stay fast", () => {
    const cands = Array.from({ length: 5000 }, (_, i) => ({ x: (i % 100) * 60, y: Math.floor(i / 100) * 40, w: 50, g: 2 }));
    const t = performance.now();
    const keep = keepLabels(cands, 16);
    assert.ok(performance.now() - t < 100, "took " + (performance.now() - t) + " ms");
    assert.ok(keep.every(Boolean));
  });
});

describe("unionRect and overlayNode", () => {
  test("union skips nulls", () => {
    assert.deepEqual(unionRect([{ x: 0, y: 0, w: 10, h: 10 }, null, { x: 20, y: -5, w: 5, h: 5 }]), { x: 0, y: -5, w: 25, h: 15 });
    assert.equal(unionRect([null]), null);
  });
  test("edits not in the file yet go on top, oldest first; removals drop keys", () => {
    const node = { id: "a", width: 100, height: 40, fill: "#fff" };
    assert.deepEqual(overlayNode(node, [{ props: { width: 120 } }, { props: { width: 130 }, remove: ["fill"] }]), { id: "a", width: 130, height: 40 });
    assert.equal(node.width, 100);
  });
});
