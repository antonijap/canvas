// Auto letter spacing: Inter Dynamic Metrics, Apple's SF / New York tables, the generic metric curve,
// auto mode in node metadata, and the server recomputing an auto node when its font or size changes.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, describe, test } from "node:test";
import { toSfnt } from "../src/fontfiles.ts";
import type { CanvasDoc, DocNode } from "../src/engine.ts";
import {
  appleTracking, applyAutoTracking, autoMetadata, autoTracking, genericTrackingEm, interTrackingEm, isAutoTracking, NEW_YORK,
  prepareAutoTracking, SF_PRO, sfntMetrics, trackingMethod,
} from "../src/tracking.ts";
import { tmpDir } from "./helpers.ts";

describe("Inter Dynamic Metrics", () => {
  // The inter-typography skill's table, em to three decimals.
  const table: [number, number][] = [
    [6, 0.043], [7, 0.032], [8, 0.024], [9, 0.016], [10, 0.01], [11, 0.005], [12, 0], [13, -0.003], [14, -0.006],
    [15, -0.009], [16, -0.011], [17, -0.013], [18, -0.014], [20, -0.017], [24, -0.019], [30, -0.021], [40, -0.022], [80, -0.022],
  ];
  for (const [size, em] of table) {
    test(`${size}px is ${em}em`, () => assert.equal(Number(interTrackingEm(size).toFixed(3)), em));
  }
  test("autoTracking answers px: em times size, to 0.01", () => {
    assert.deepEqual(autoTracking("Inter", 16), { px: -0.18, method: "inter" });
    assert.equal(autoTracking("Inter", 12).px, 0.01);
    assert.equal(autoTracking("Inter", 32).px, -0.69);
    assert.equal(autoTracking("InterVariable", 32).px, -0.69);
  });
});

describe("Apple tracking tables", () => {
  test("SF Pro matches Apple's chart at every published size", () => {
    for (const [size, pt] of Object.entries(SF_PRO)) assert.equal(autoTracking("SF Pro", Number(size)).px, pt, `size ${size}`);
    assert.equal(autoTracking("SF Pro Text", 17).px, -0.43);
    assert.equal(autoTracking("system-ui", 34).px, 0.4);
    assert.equal(autoTracking("-apple-system", 13).px, -0.08);
  });
  test("between rows the nearest row wins, outside the chart the end rows hold", () => {
    assert.equal(appleTracking(SF_PRO, 16.4), -0.31);
    assert.equal(appleTracking(SF_PRO, 16.6), -0.43);
    assert.equal(appleTracking(SF_PRO, 49), 0.35, "a tie takes the lower row");
    assert.equal(appleTracking(SF_PRO, 4), 0.24);
    assert.equal(appleTracking(SF_PRO, 120), 0);
  });
  test("SF Pro Rounded and New York use their own charts", () => {
    assert.equal(autoTracking("SF Pro Rounded", 17).px, 0.37);
    assert.equal(autoTracking("New York", 17).px, -0.07);
    for (const [size, pt] of Object.entries(NEW_YORK)) assert.equal(autoTracking("New York", Number(size)).px, pt);
  });
  test("family names map to the right curve; Inter Tight and Inter Display are not Inter", () => {
    assert.equal(trackingMethod('"Inter", sans-serif'), "inter");
    assert.equal(trackingMethod("inter tight"), "generic");
    assert.equal(trackingMethod("Inter Display"), "generic");
    assert.equal(trackingMethod("SF Pro Display"), "sf");
    assert.equal(trackingMethod("ui-rounded"), "sf-rounded");
    assert.equal(trackingMethod("SF Mono"), "generic");
  });
});

describe("generic curve", () => {
  const fonts = {
    default: undefined,
    smallX: { upm: 1000, xHeight: 450 }, // Times-like
    bigX: { upm: 1000, xHeight: 600 }, // Verdana-like
  };
  for (const [name, m] of Object.entries(fonts)) {
    test(`${name}: falls monotonically from 8 to 96 px and stays within -2.5%..+4%`, () => {
      let prev = Infinity;
      for (let z = 8; z <= 96; z += 0.5) {
        const em = genericTrackingEm(z, m);
        assert.ok(em <= prev, `not monotonic at ${z}`);
        assert.ok(em > -0.025 && em < 0.04, `${em} at ${z}`);
        prev = em;
      }
      assert.ok(genericTrackingEm(8, m) > 0, "small text opens up");
      assert.ok(genericTrackingEm(96, m) < 0, "display text tightens");
    });
  }
  test("a smaller x-height means looser tracking at the same size", () => {
    assert.ok(genericTrackingEm(14, fonts.smallX) > genericTrackingEm(14, fonts.bigX));
  });
  test("is gentler than Inter, and monospaced fonts stay at 0", () => {
    assert.ok(Math.abs(genericTrackingEm(48)) < Math.abs(interTrackingEm(48)));
    assert.equal(genericTrackingEm(48, { upm: 1000, monospace: true }), 0);
    assert.equal(autoTracking("Menlo", 48, { upm: 2048, monospace: true }).px, 0);
  });
  test("sfntMetrics reads a real font file", () => {
    const f = "/System/Library/Fonts/Helvetica.ttc";
    if (!fs.existsSync(f)) return;
    const m = sfntMetrics(toSfnt(fs.readFileSync(f), 0));
    assert.ok(m && m.upm > 0 && (m.xHeight ?? 0) > 0, JSON.stringify(m));
    assert.ok(m!.xHeight! / m!.upm > 0.45 && m!.xHeight! / m!.upm < 0.6);
    assert.ok(!m!.monospace);
    const mono = "/System/Library/Fonts/Menlo.ttc";
    if (fs.existsSync(mono)) assert.equal(sfntMetrics(toSfnt(fs.readFileSync(mono), 0))?.monospace, true);
  });
});

describe("auto mode on a node", () => {
  test("metadata gains and loses only Canvas's key", () => {
    assert.deepEqual(autoMetadata(undefined, true), { type: "canvas", canvasLetterSpacing: "auto" });
    assert.equal(autoMetadata({ type: "canvas", canvasLetterSpacing: "auto" }, false), null);
    assert.deepEqual(autoMetadata({ type: "other-thing", x: 1 }, true), { type: "other-thing", x: 1, canvasLetterSpacing: "auto" });
    assert.deepEqual(autoMetadata({ type: "other-thing", x: 1, canvasLetterSpacing: "auto" }, false), { type: "other-thing", x: 1 });
  });

  const doc = () =>
    ({
      version: "2.21",
      variables: { body: { type: "number", value: 17 }, face: { type: "string", value: "SF Pro" } },
      children: [{ type: "frame", id: "B", children: [{ type: "text", id: "T", content: "Hi", fontFamily: "Inter", fontSize: 16, letterSpacing: -0.18, metadata: { type: "canvas", canvasLetterSpacing: "auto" } }] }],
    }) as unknown as CanvasDoc;
  const textOf = (d: CanvasDoc) => (d.children[0] as DocNode).children![0];

  test("a size or family change recomputes; variables resolve", () => {
    const d = doc();
    const t = textOf(d);
    Object.assign(t, { fontSize: 32 });
    assert.equal(applyAutoTracking(d, t, { fontSize: 32 }), -0.69);
    Object.assign(t, { fontFamily: "$face", fontSize: "$body" });
    applyAutoTracking(d, t, { fontFamily: "$face", fontSize: "$body" });
    assert.equal(t.letterSpacing, -0.43);
  });
  test("an explicit letterSpacing turns auto off; other edits leave it alone", () => {
    const d = doc();
    const t = textOf(d);
    assert.equal(applyAutoTracking(d, t, { content: "x" }), undefined);
    Object.assign(t, { letterSpacing: 0 });
    applyAutoTracking(d, t, { letterSpacing: 0 });
    assert.equal(isAutoTracking(t), false);
    assert.equal(t.metadata, undefined);
    assert.equal(t.letterSpacing, 0);
  });
  test("prepare fetches metrics only for a generic family on an auto node", async () => {
    const asked: string[] = [];
    const lookup = async (f: string, w: number) => (asked.push(`${f} ${w}`), { upm: 1000, xHeight: 500 });
    assert.equal(await prepareAutoTracking(doc(), "T", { fontSize: 20 }, [], lookup), undefined);
    assert.deepEqual(await prepareAutoTracking(doc(), "T", { fontFamily: "Georgia", fontWeight: "700" }, [], lookup), { upm: 1000, xHeight: 500 });
    assert.equal(await prepareAutoTracking(doc(), "T", { content: "x" }, [], lookup), undefined);
    assert.deepEqual(asked, ["Georgia 700"]);
  });
  test("removing the family recomputes for the default, Inter", () => {
    const d = doc();
    const t = textOf(d);
    Object.assign(t, { fontFamily: "SF Pro", letterSpacing: -0.31 });
    delete t.fontFamily;
    assert.equal(applyAutoTracking(d, t, {}, undefined, ["fontFamily"]), -0.18);
  });
  test("letterSpacing with auto switched on in the same edit keeps auto", () => {
    const d = doc();
    const t = textOf(d);
    const props = { letterSpacing: 2, metadata: { type: "canvas", canvasLetterSpacing: "auto" } };
    Object.assign(t, props);
    assert.equal(applyAutoTracking(d, t, props), -0.18);
  });
  test("themed size variables resolve in the document's default theme", () => {
    const d = { ...doc(), themes: { mode: ["light", "dark"] }, variables: { body: { type: "number", value: [{ value: 16 }, { value: 32, theme: { mode: "light" } }] } } } as unknown as CanvasDoc;
    const t = textOf(d);
    Object.assign(t, { fontSize: "$body" });
    assert.equal(applyAutoTracking(d, t, { fontSize: "$body" }), -0.69);
  });
});

describe("through /api/update", async () => {
  const dir = tmpDir("tracking");
  process.env.CANVAS_ROOTS = dir;
  process.env.CANVAS_WEB_FONTS = "0";
  const { startServer } = await import("../src/server.ts");
  const server = await startServer(0);
  const port = (server.address() as { port: number }).port;
  const file = path.join(dir, "t.canvas.json");
  fs.writeFileSync(file, JSON.stringify({ version: "2.21", children: [{ type: "frame", id: "B", x: 0, y: 0, width: 200, height: 100, children: [{ type: "text", id: "T", content: "Hi", fontFamily: "Inter", fontSize: 16 }] }] }, null, 2));
  after(() => {
    fs.unwatchFile(fs.realpathSync(file));
    server.closeAllConnections();
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const post = (props: Record<string, unknown>, remove: string[] = []) =>
    fetch(`http://127.0.0.1:${port}/api/update`, { method: "POST", headers: { "content-type": "application/json", "x-canvas": "1" }, body: JSON.stringify({ file, id: "T", props, remove }) });
  const text = () => JSON.parse(fs.readFileSync(file, "utf8")).children[0].children[0];

  test("turning auto on writes the value; a size change recomputes it in the same write", async () => {
    assert.equal((await post({ metadata: { type: "canvas", canvasLetterSpacing: "auto" } })).status, 200);
    assert.equal(text().letterSpacing, -0.18);
    const r = await post({ fontSize: 48 });
    assert.equal(r.status, 200);
    assert.equal(((await r.json()) as { node: { letterSpacing: number } }).node.letterSpacing, -1.07);
    assert.equal(text().letterSpacing, -1.07);
    await post({ fontFamily: "SF Pro" });
    assert.equal(text().letterSpacing, 0.35);
  });
  test("a typed value turns auto off and the file keeps no Canvas metadata", async () => {
    await post({ letterSpacing: 0 }, ["metadata"]);
    const t = text();
    assert.equal(t.letterSpacing, 0);
    assert.equal(t.metadata, undefined);
    await post({ fontSize: 12 });
    assert.equal(text().letterSpacing, 0, "manual stays manual");
  });
});
