// Pure helpers of the page's engine renderer (src/page/engine-view.js): theme colour, the node index, move detection.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
// @ts-expect-error: a browser module without types
import { boardsToReorder, contentKey, sceneTextAndKey, cssColorToHex, DECODE_CONCURRENCY, decodedBytes, DECODER_SRC, engineModuleUrl, ENGINE_MAX_RESTARTS, ENGINE_RESTART_WINDOW_MS, engineRestartDelay, FULL_IMAGE_SIDE, hash53, IMAGE_BUDGET, IMAGE_CAPS, imageCapFor, imageRetryDelay, indexScene, inSlices, MAX_IMAGE_SIDE, PARK_MAX_BOARDS, PARK_MAX_NODES, parkedToEvict, PLACE_SLICE_IDLE_MS, PLACE_SLICE_MS, placeOrder, planImageDecodes, raiseInOrder, SMALL_IMAGE_SIDE, useInView, withTimeout } from "../src/page/engine-view.js";

describe("cssColorToHex (the engine background follows the page's canvas colour)", () => {
  test("rgb, rgba and hex forms", () => {
    assert.equal(cssColorToHex("rgb(245, 245, 245)"), "#f5f5f5");
    assert.equal(cssColorToHex("rgba(24, 24, 27, 0.5)"), "#18181b80");
    assert.equal(cssColorToHex("rgba(24, 24, 27, 1)"), "#18181b");
    assert.equal(cssColorToHex("rgb(24 24 27 / 50%)"), "#18181b80");
    assert.equal(cssColorToHex("#ABC"), "#aabbcc");
    assert.equal(cssColorToHex("#18181B"), "#18181b");
  });
  test("unreadable values are null", () => {
    assert.equal(cssColorToHex("color(display-p3 1 0 0)"), null);
    assert.equal(cssColorToHex(""), null);
    assert.equal(cssColorToHex(undefined), null);
  });
});

describe("indexScene", () => {
  const root = {
    id: "B", type: "frame", cornerRadius: 12, children: [
      { id: "I/a", type: "rectangle", cornerRadius: [4, 4, 0, 0], fill: [{ type: "image", url: "/asset?p=x.png" }, "#fff"] },
      { id: "E", type: "ellipse" },
      { id: "T", type: "text", stroke: { type: "image", url: "/asset?p=y.png" } },
    ],
  };
  test("every id maps to its board and corner radius; image fills and strokes are collected", () => {
    const index = new Map();
    const uses: [string, string][] = [];
    const ids = indexScene(root, "B", index, uses);
    assert.deepEqual([...ids].sort(), ["B", "E", "I/a", "T"]);
    assert.deepEqual(index.get("I/a"), { board: "B", radius: 4, parent: "B", name: "", type: "rectangle", instance: false });
    assert.equal(index.get("B").parent, null);
    assert.equal(index.get("B").radius, 12);
    assert.ok(index.get("E").radius > 1e6, "an ellipse is fully round");
    assert.equal(index.get("T").radius, 0);
    assert.deepEqual(uses, [["I/a", "/asset?p=x.png"], ["T", "/asset?p=y.png"]]);
  });
});

describe("contentKey", () => {
  const scene = (x: number, y: number, fill = "#fff") => ({ x, y, root: { id: "B", x, y, fill, children: [] }, fonts: [], images: [] });
  test("a move keeps the key; a content change does not", () => {
    assert.equal(contentKey(scene(0, 0)), contentKey(scene(500, -20)));
    assert.notEqual(contentKey(scene(0, 0)), contentKey(scene(0, 0, "#000")));
  });
  test("sceneTextAndKey: one stringify gives contentKey and the same scene for the engine", () => {
    const deep = (v: unknown): unknown => (Array.isArray(v) ? v.map(deep) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, deep((v as any)[k])])) : v);
    for (const s of [scene(3, 4), { id: "B", revision: "r", root: { id: "B", children: [{ id: "c", x: 1 }] } }, { root: { x: 2 }, fonts: undefined }, { root: { id: "B", x: 1, y: 2 }, warnings: ["w"], images: ["/asset?p=a.png"] }]) {
      const { text, content } = sceneTextAndKey(s);
      assert.equal(content, contentKey(s));
      assert.deepEqual(deep(JSON.parse(text)), deep(JSON.parse(JSON.stringify(s))));
    }
  });
  test("hash53 is stable and spreads", () => {
    assert.equal(hash53("abc"), hash53("abc"));
    assert.notEqual(hash53("abc"), hash53("abd"));
    assert.ok(Number.isSafeInteger(hash53("x".repeat(10000))));
  });
  test("image decode sizes follow the engine's mip levels", () => {
    assert.equal(MAX_IMAGE_SIDE, 2048);
    assert.ok(SMALL_IMAGE_SIDE < MAX_IMAGE_SIDE);
  });
});

describe("boardsToReorder (paint order follows the document: boards load out of order, Arrange reorders)", () => {
  const rects: Record<string, { x: number; y: number; w: number; h: number }> = {
    A: { x: 0, y: 0, w: 100, h: 100 }, B: { x: 50, y: 50, w: 100, h: 100 }, C: { x: 140, y: 140, w: 50, h: 50 }, D: { x: 1000, y: 0, w: 10, h: 10 }, E: { x: 60, y: 60, w: 10, h: 10 },
  };
  const rectOf = (id: string) => rects[id] ?? null;
  const by = (order: string[]) => (id: string) => order.indexOf(id);
  test("a board that loads last goes under the later boards it overlaps, directly or through each other", () => {
    // Document E A B C D; the engine got D C B E, then A (appended on top).
    assert.deepEqual(boardsToReorder(["D", "C", "B", "E", "A"], by(["E", "A", "B", "C", "D"]), rectOf), ["B", "C"]);
  });
  test("nothing to do when overlapping boards already stack as the document says", () => {
    assert.deepEqual(boardsToReorder(["E", "A", "B", "C", "D"], by(["E", "A", "B", "C", "D"]), rectOf), []);
    assert.deepEqual(boardsToReorder(["D", "A"], by(["A", "D"]), rectOf), []); // far apart: order does not matter
  });
  test("Arrange: the front board sent backward puts the other one back on top", () => {
    // B was drawn over A; B sent to the back makes the document B, A: A goes up.
    assert.deepEqual(boardsToReorder(["A", "B"], by(["B", "A"]), rectOf), ["A"]);
    // E sent to the back under A and B, which overlap it: both go up, in document order.
    assert.deepEqual(boardsToReorder(["B", "A", "E"], by(["E", "A", "B"]), rectOf), ["A", "B"]);
  });
  test("the result always stacks every overlapping pair in document order", () => {
    let seed = 3;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let round = 0; round < 50; round++) {
      const ids = Array.from({ length: 12 }, (_, i) => "b" + i);
      const rs: Record<string, any> = Object.fromEntries(ids.map((id) => [id, { x: rnd() * 400, y: rnd() * 400, w: 50 + rnd() * 100, h: 50 + rnd() * 100 }]));
      const paint = ids.slice().sort(() => rnd() - 0.5), order = ids.slice().sort(() => rnd() - 0.5);
      const ord = by(order), up = boardsToReorder(paint, ord, (id: string) => rs[id]);
      const final = raiseInOrder(paint.slice(), up);
      assert.deepEqual(final, [...paint.filter((id) => !up.includes(id)), ...up], "raising is the engine's raiseBoards: up on top, in order");
      const hit = (a: any, b: any) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      for (let i = 0; i < final.length; i++) for (let j = i + 1; j < final.length; j++) if (hit(rs[final[i]], rs[final[j]])) assert.ok(ord(final[i]) < ord(final[j]), final.join(" "));
    }
  });
});

describe("GPU device loss (hunt 5: one loss used to mean the DOM renderer for the rest of the session)", () => {
  test("a loss restarts the engine, waiting longer each time", () => {
    assert.equal(engineRestartDelay([], 1000), 250);
    assert.equal(engineRestartDelay([500], 1000), 500);
    assert.equal(engineRestartDelay([200, 500], 1000), 1000);
  });
  test("the DOM renderer only after losses keep coming", () => {
    const losses = Array.from({ length: ENGINE_MAX_RESTARTS }, (_, i) => 1000 + i * 1000);
    assert.equal(engineRestartDelay(losses, 5000), -1);
    assert.ok(engineRestartDelay(losses, 1000 + ENGINE_RESTART_WINDOW_MS + 3000) > 0, "old losses age out");
  });
  // A wasm panic aborts its instance: an engine restarted in the same instance never came up (renderer "pending").
  test("every engine after the first loads its own wasm instance", () => {
    assert.equal(engineModuleUrl(0), "/engine/canvas_engine.js");
    assert.equal(engineModuleUrl(1), "/engine/canvas_engine.js?i=1");
    assert.notEqual(engineModuleUrl(2), engineModuleUrl(1));
  });
  test("an engine that never starts is given up on", async () => {
    await assert.rejects(withTimeout(new Promise(() => {}), 20, "no start"), /no start/);
    assert.equal(await withTimeout(Promise.resolve(7), 20, "no start"), 7);
  });
});

describe("decoded image budget and retries", () => {
  const MB = 1 << 20;
  // Review round 6, Fable 1: the decode size was chosen per board and by the long side alone, with one step from
  // 2048 px straight to the image's own pixels (up to 32 Mpx, 128 MB). A page of 30 full-page screenshots at 16%
  // (each 1920 device px tall, 0.4 Mpx on screen) decoded 3.8 GB.
  const shot = (i: number, over: Record<string, unknown> = {}) => ({ url: "s" + i, cap: 512, bytes: 61 * 512 * 4, nw: 2880, nh: 24000, aspect: 0.12, want: 512, shown: false, busy: false, at: i, ...over });
  type Plan = { url: string; cap: number };
  const total = (items: any[], plan: Plan[]) => items.reduce((n, it) => n + decodedBytes(it, (plan.find((p: Plan) => p.url === it.url) ?? it).cap), 0);
  test("the decode step follows the size on screen", () => {
    assert.deepEqual([100, 460, 461, 1843, 1844, 2751, 2752, 3840, 3892, 5503, 7782, 7783, 11005, 40000].map(imageCapFor), [512, 512, 2048, 2048, 2896, 2896, 4096, 4096, 5792, 8192, 8192, 11584, 16384, 16384]);
    assert.deepEqual([IMAGE_CAPS[0], IMAGE_CAPS[1], IMAGE_CAPS.at(-1)], [SMALL_IMAGE_SIDE, MAX_IMAGE_SIDE, FULL_IMAGE_SIDE]);
    assert.ok(IMAGE_CAPS.every((c: number, i: number) => i === 0 || c > IMAGE_CAPS[i - 1]));
  });
  test("30 full-page screenshots at 16% on a 2x display stay far inside the budget", () => {
    // 1440 x 12000 nodes at 16% on 2x: 3840 device px tall, 461 wide, all in view. Sources are 2880 x 24000.
    const want = imageCapFor(12000 * 0.16 * 2);
    assert.equal(want, 4096);
    const items = Array.from({ length: 30 }, (_, i) => shot(i, { want, shown: true }));
    const plan = planImageDecodes(items, IMAGE_BUDGET);
    assert.equal(plan.length, 30);
    assert.ok(plan.every((p: Plan) => p.cap === 4096));
    // 492 x 4096 px each, 8 MB: 242 MB for all 30.
    const mb = total(items, plan) / MB;
    assert.ok(mb < 250 && mb < IMAGE_BUDGET / MB / 3, `${mb} MB`);
    // Before: every one of them at its own pixels, capped at 32 Mpx: 3.8 GB.
    assert.ok(30 * decodedBytes(shot(0), FULL_IMAGE_SIDE) > 3.5 * 1024 * MB);
    // Not known yet how large they are (the first decode): planned from the shape they are drawn in, the same.
    const unknown = items.map((it) => ({ ...it, cap: 0, bytes: 0, nw: 0, nh: 0 }));
    assert.ok(total(unknown, planImageDecodes(unknown, IMAGE_BUDGET)) / MB < 250);
  });
  test("an image is judged by its own rectangle, not by its board", () => {
    // A moodboard of photos; the view is zoomed into the one at 2000, 0.
    const rects = [{ x: 0, y: 0, w: 1500, h: 2000 }, { x: 2000, y: 0, w: 1500, h: 2000 }];
    const view = { x: 2100 + 500, y: 300, w: 700, h: 450 };
    assert.equal(useInView([rects[0]], 500, 0, view), 0, "the photo beside it is out of view");
    assert.equal(useInView([rects[1]], 500, 0, view), 2000);
    assert.equal(useInView(rects, 500, 0, { x: 0, y: 0, w: 10000, h: 10000 }), 2000);
    // In the plan: the photo in view goes up, the rest stay small.
    const photo = (i: number, shown: boolean) => ({ url: "p" + i, cap: 512, bytes: 384 * 512 * 4, nw: 6000, nh: 8000, aspect: 0.75, want: shown ? 16384 : 512, shown, busy: false, at: i });
    const plan = planImageDecodes(Array.from({ length: 40 }, (_, i) => photo(i, i === 7)), IMAGE_BUDGET);
    assert.deepEqual(plan, [{ url: "p7", cap: 16384 }]);
  });
  test("an image whose own pixels are all held is not decoded again (Fable 6)", () => {
    // 1600 x 1200, held from the 2048 step: nothing was shrunk, the 16384 step has the same pixels.
    const web = { url: "w", cap: 2048, bytes: 1600 * 1200 * 4, nw: 1600, nh: 1200, aspect: 0.75, want: 16384, shown: true, busy: false, at: 0 };
    assert.deepEqual(planImageDecodes([web], IMAGE_BUDGET), []);
    // 8000 x 8000 held at the area cap: 8192 and 16384 are the same 32 Mpx.
    const big = { ...web, url: "b", cap: 8192, nw: 8000, nh: 8000, bytes: 5657 * 5657 * 4, want: 16384 };
    assert.deepEqual(planImageDecodes([big], IMAGE_BUDGET), []);
    // Shrunk at the 2048 step, it does go up.
    assert.deepEqual(planImageDecodes([{ ...web, nw: 4000, nh: 3000, bytes: 2048 * 1536 * 4 }], IMAGE_BUDGET), [{ url: "w", cap: 16384 }]);
  });
  test("over the budget: out of view first, then what is held larger than needed, then the largest in view", () => {
    const full = (i: number, over: Record<string, unknown> = {}) => shot(i, { cap: 16384, bytes: decodedBytes(shot(0), 16384), want: 4096, shown: true, ...over });
    // Ten screenshots visited at 100% (128 MB each), now all in view at an overview that needs the 4096 step.
    const visited = Array.from({ length: 10 }, (_, i) => full(i));
    assert.ok(total(visited, []) > 1200 * MB);
    const plan = planImageDecodes(visited, IMAGE_BUDGET);
    assert.ok(plan.length >= 4 && plan.length < 10 && plan.every((p: Plan) => p.cap === 4096), "only as many step down as the budget needs");
    assert.ok(total(visited, plan) <= IMAGE_BUDGET);
    // Under the budget nothing steps down: zooming back in costs no decode.
    assert.deepEqual(planImageDecodes(visited.slice(0, 5), IMAGE_BUDGET), []);
    // Images out of view go first, least recently shown first, and never one that is decoding.
    const mixed = [full(0), full(1, { shown: false, at: 30 }), full(2, { shown: false, at: 10 }), full(3, { shown: false, busy: true }), full(4), full(5), full(6)];
    assert.deepEqual(planImageDecodes(mixed, 6 * 128 * MB + MB), [{ url: "s2", cap: 512 }]);
    assert.deepEqual(planImageDecodes(mixed, 5 * 128 * MB + MB).map((p: Plan) => p.url), ["s1", "s2"]);
    // Images in view that all need their own pixels: the largest take a smaller step until it fits.
    const zoomed = Array.from({ length: 8 }, (_, i) => full(i, { cap: 2048, bytes: decodedBytes(shot(0), 2048), want: 16384 }));
    const up = planImageDecodes(zoomed, IMAGE_BUDGET);
    assert.ok(total(zoomed, up) <= IMAGE_BUDGET && up.some((p: Plan) => p.cap === 16384) && up.some((p: Plan) => p.cap < 16384), JSON.stringify(up));
    // And the plan is stable: once those decodes have landed, it asks for nothing more.
    const landed = zoomed.map((it) => { const cap = (up.find((p: Plan) => p.url === it.url) ?? it).cap; return { ...it, cap, bytes: decodedBytes(it, cap) }; });
    assert.deepEqual(planImageDecodes(landed, IMAGE_BUDGET), []);
  });
  test("a decode that failed for a passing reason is tried again: 1 s, 2 s ... at most 30 s", () => {
    assert.deepEqual([1, 2, 3, 6, 20].map(imageRetryDelay), [1000, 2000, 4000, 30000, 30000]);
  });
});

// Stress (docs/perf/stress.md): 500 boards placed in one task froze the page for 7 s at the overview.
describe("board placement in slices", () => {
  test("yields whenever a slice used its budget, and every slice places at least one board", async () => {
    let t = 0, yields = 0;
    const done: number[] = [];
    // each board costs 3 ms: 8 ms slices hold 3 boards; a 20 ms board runs alone
    const cost = [3, 3, 3, 3, 20, 3, 3];
    await inSlices(cost.map((_, i) => i), (i: number) => { done.push(i); t += cost[i]; }, { budgetMs: PLACE_SLICE_MS, now: () => t, next: async () => { yields++; } });
    assert.deepEqual(done, [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(yields, 2, "slices: [0,1,2] [3,4] [5,6]");
  });
  test("500 boards never run 500 in one slice", async () => {
    let t = 0, longest = 0, run = 0;
    await inSlices(Array.from({ length: 500 }, (_, i) => i), () => { t += 14; run++; longest = Math.max(longest, run); }, { budgetMs: 8, now: () => t, next: async () => { run = 0; } });
    assert.equal(longest, 1);
  });
  test("the budget can change between slices (larger while the camera is still)", async () => {
    let t = 0, idle = true, yields = 0;
    await inSlices(Array.from({ length: 12 }, (_, i) => i), () => { t += 5; if (t >= 30) idle = false; }, { budgetMs: () => (idle ? PLACE_SLICE_IDLE_MS : PLACE_SLICE_MS), now: () => t, next: async () => { yields++; } });
    assert.ok(PLACE_SLICE_IDLE_MS > PLACE_SLICE_MS);
    assert.equal(yields, 4, "4 boards in the first (idle) slice, 2 in the next (the gesture starts in it), then 2 per slice");
  });
  test("nearest the view centre first", () => {
    const rects = [{ x: 5000, y: 0, width: 100, height: 100 }, { x: 0, y: 0, width: 100, height: 100 }, { x: 900, y: 0, width: 100, height: 100 }];
    assert.deepEqual(placeOrder(rects, { x: 0, y: 0, z: 1 }, 100, 100), [1, 2, 0]);
    assert.deepEqual(placeOrder(rects, null, 100, 100), [0, 1, 2]);
  });
});

describe("restacking on a 1,000-board file (stress: 15 s of 20 in nodeRect + all pairs)", () => {
  test("reads each board's rect once and does not compare every pair", async () => {
    const ids = Array.from({ length: 4000 }, (_, i) => `b${i}`);
    let reads = 0;
    const rect = (id: string) => { reads++; const i = Number(id.slice(1)); return { x: (i % 50) * 500, y: Math.floor(i / 50) * 1000, w: 400, h: 900 }; };
    const t0 = performance.now();
    assert.deepEqual(boardsToReorder(ids, (id: string) => Number(id.slice(1)), rect), []);
    assert.equal(reads, 4000);
    assert.ok(performance.now() - t0 < 200, `took ${performance.now() - t0} ms`);
  });
  test("an overlapping pair found by the sweep still restacks", async () => {
    const r: Record<string, object> = { a: { x: 0, y: 0, w: 100, h: 100 }, far: { x: 50, y: 5000, w: 10, h: 10 }, b: { x: 90, y: 90, w: 50, h: 50 } };
    // paint order b (bottom), far, a; the document puts b above a
    assert.deepEqual(boardsToReorder(["b", "far", "a"], (id: string) => ({ a: 0, far: 1, b: 2 } as any)[id], (id: string) => r[id]), ["b"]);
  });
});

describe("image decoder worker (stress: 8k shrink blocked the main thread 80 ms; 200 at once failed)", () => {
  // Run the worker's source with fake fetch / createImageBitmap / postMessage.
  async function runWorker(jobs: { id: number; url: string; cap: number }[], dims: (url: string) => [number, number]) {
    let live = 0, peak = 0;
    const posted: any[] = [], resized: any[] = [];
    const g: any = {
      fetch: async (url: string) => { live++; peak = Math.max(peak, live); await new Promise((r) => setTimeout(r, 5)); return url.includes("gone") ? { ok: false, status: 404 } : { ok: true, headers: new Headers({ etag: '"image"' }), blob: async () => ({ url, type: url.endsWith(".jpg") ? "image/jpeg" : "image/png" }) }; },
      createImageBitmap: async (src: any, o?: any) => { if (o) { resized.push([o.resizeWidth, o.resizeHeight]); return { width: o.resizeWidth, height: o.resizeHeight, close() {} }; } const [w, h] = dims(src.url); return { width: w, height: h, close() { live--; } }; },
      postMessage: (m: any) => { if (!m.bm) live--; posted.push(m); },
    };
    const self: any = {};
    new Function("self", "fetch", "createImageBitmap", "postMessage", DECODER_SRC.replace("__MAX__", String(DECODE_CONCURRENCY)))(self, g.fetch, g.createImageBitmap, g.postMessage);
    const onmessage = self.onmessage;
    for (const j of jobs) onmessage({ data: j });
    while (posted.length < jobs.length) await new Promise((r) => setTimeout(r, 2));
    return { posted, resized, peak, max: DECODE_CONCURRENCY };
  }
  test("at most DECODE_CONCURRENCY decodes at once, shrunk to the cap, 4xx passed on", async () => {
    const jobs = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, url: i === 3 ? "/gone.png" : `/i${i}.jpg`, cap: 2048 }));
    const r = await runWorker(jobs, () => [8192, 4096]);
    assert.ok(r.peak <= r.max, `peak ${r.peak}`);
    assert.equal(r.posted.length, 12);
    assert.deepEqual(r.posted.find((m) => m.id === 4), { id: 4, status: 404, error: "404" });
    assert.deepEqual(r.resized[0], [2048, 1024]);
    assert.equal(r.posted.filter((m) => m.bm).length, 11);
  });
  test("the full decode is capped by area, not by the long side", async () => {
    const r = await runWorker([{ id: 1, url: "/tall.png", cap: 16384, px: 32e6 } as any, { id: 2, url: "/huge.png", cap: 16384, px: 32e6 } as any], (u) => (u.includes("tall") ? [1200, 16000] : [8000, 8000]));
    assert.equal(r.posted.find((m) => m.id === 1).bm.height, 16000, "19.2 Mpx: its own pixels");
    assert.deepEqual(r.resized, [[5657, 5657]], "64 Mpx: shrunk to 32 Mpx");
  });
  test("the worker reports the image's own size and that a JPEG has no transparency", async () => {
    const r = await runWorker([{ id: 1, url: "/photo.jpg", cap: 2048 }, { id: 2, url: "/shot.png", cap: 2048 }], () => [8192, 4096]);
    const jpg = r.posted.find((m) => m.id === 1), png = r.posted.find((m) => m.id === 2);
    assert.deepEqual([jpg.nw, jpg.nh, jpg.bm.width], [8192, 4096, 2048]);
    assert.equal(jpg.opaque, true);
    assert.equal(jpg.etag, '"image"');
    assert.equal(png.opaque, undefined, "a small PNG is never tiled: nobody needs to know");
  });
  test("a small image is not resized", async () => {
    const r = await runWorker([{ id: 1, url: "/s.png", cap: 512 }], () => [300, 200]);
    assert.equal(r.resized.length, 0);
    assert.equal(r.posted[0].bm.width, 300);
  });
});

describe("parked boards (page switches hide boards instead of removing them)", () => {
  const recs = (sizes: number[]) => new Map(sizes.map((n, i) => [`b${i}`, { ids: new Set(Array.from({ length: n }, (_, k) => `n${i}_${k}`)) }]));
  test("within both limits nothing goes", () => {
    assert.deepEqual(parkedToEvict(recs([10, 20]), 30, 100, 5), []);
    assert.ok(PARK_MAX_NODES >= 10_000 && PARK_MAX_BOARDS >= 50);
  });
  test("over the node limit: the oldest parked go first until the rest fit", () => {
    assert.deepEqual(parkedToEvict(recs([50, 30, 40]), 120, 70, 10), ["b0"]);
    assert.deepEqual(parkedToEvict(recs([50, 30, 40]), 120, 40, 10), ["b0", "b1"]);
  });
  test("over the board limit: the oldest go", () => {
    assert.deepEqual(parkedToEvict(recs([1, 1, 1, 1]), 4, 100, 2), ["b0", "b1"]);
  });
});

// Audit finding 4: every decode was capped at 2048 px on the long side, so a 1200 x 8000 screenshot reached the
// engine as 307 x 2048. An image shown larger than that now gets its own pixels, capped by area.
test("an image shown large is decoded at its own pixels, capped by area", async () => {
  // @ts-expect-error engine-view.js is an untyped page module
  const { imageCapFor, decodeScale, MAX_IMAGE_SIDE, SMALL_IMAGE_SIDE, FULL_IMAGE_SIDE, FULL_IMAGE_PX } = await import("../src/page/engine-view.js");
  assert.equal(imageCapFor(100), SMALL_IMAGE_SIDE);
  assert.equal(imageCapFor(1000), MAX_IMAGE_SIDE);
  assert.equal(decodeScale(1200, 8000, imageCapFor(8000)), 1, "a tall screenshot at 100% on a 2x display: its own pixels");
  assert.equal(imageCapFor(20000), FULL_IMAGE_SIDE);
  assert.equal(decodeScale(1200, 8000, FULL_IMAGE_SIDE), 1, "9.6 Mpx: untouched");
  assert.equal(decodeScale(1200, 16000, FULL_IMAGE_SIDE), 1, "19.2 Mpx: untouched");
  assert.ok(Math.abs(decodeScale(1200, 8000, MAX_IMAGE_SIDE) - 0.256) < 1e-9, "the large tier is still 2048 px long");
  const k = decodeScale(8000, 8000, FULL_IMAGE_SIDE);
  assert.ok(k < 1 && Math.abs(8000 * 8000 * k * k - FULL_IMAGE_PX) < 1, "64 Mpx is shrunk to the area cap");
  assert.equal(decodeScale(300, 200, SMALL_IMAGE_SIDE), 1, "never enlarged");
});

// Audit finding 2: the ResizeObserver resized the canvas (which clears it) and left the draw to the next rAF, so
// every frame presented while the window edge was dragged was empty.
test("a resize draws in the same task, with the page's camera", async () => {
  // @ts-expect-error engine-view.js is an untyped page module
  const { resizeAndDraw } = await import("../src/page/engine-view.js");
  const calls: string[] = [];
  const engine = {
    resize: (w: number, h: number, d: number) => calls.push(`resize ${w} ${h} ${d}`),
    setCamera: (x: number, y: number, z: number) => calls.push(`camera ${x} ${y} ${z}`),
    frame: () => { calls.push("frame"); return true; },
  };
  assert.equal(resizeAndDraw(engine, 1000, 700, 2, { x: -40, y: 12, z: 1.5 }), true, "tiles still to draw: the caller keeps the loop going");
  assert.deepEqual(calls, ["resize 1000 700 2", "camera -40 12 1.5", "frame"], "drawn before the function returns, after the size and camera");
  calls.length = 0;
  resizeAndDraw(engine, 800, 600, 1, null);
  assert.deepEqual(calls, ["resize 800 600 1", "frame"], "no camera yet (the first layout): still drawn");
  // Review round 6, Fable 13: an engine that has redraw() draws with it (no tiles, outside its frame clock).
  calls.length = 0;
  const now = { ...engine, redraw: () => { calls.push("redraw"); return false; } };
  assert.equal(resizeAndDraw(now, 800, 600, 2, null), false);
  assert.deepEqual(calls, ["resize 800 600 2", "redraw"]);
});
