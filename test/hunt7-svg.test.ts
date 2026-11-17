// Bug hunt 2026-11-16: SVG export of a child of a rotated frame (src/doc/render/svg.ts). Needs a Chromium; skipped without one.

import assert from "node:assert/strict";
import { test } from "node:test";
import { exportTargets, shutdownRenderer } from "../src/doc/render/index.ts";

const doc: any = {
  version: "2.21",
  children: [
    { type: "frame", id: "F", x: 0, y: 0, width: 300, height: 300, rotation: 90, layout: "none", children: [
      { type: "frame", id: "K", x: 10, y: 10, width: 100, height: 50, fill: "#ff0000" },
    ] },
  ],
};

test("a child of a rotated frame exports at its own size and orientation", (t) => {
  let shots;
  try {
    shots = exportTargets(doc.children, { doc, file: "/tmp/hunt7-svg.canvas.json" }, [{ id: "K", format: "svg" }]);
  } catch (e) {
    if (/chrom|browser|executable|launch/i.test((e as Error).message)) return t.skip("no Chromium here");
    throw e;
  } finally {
    try { shutdownRenderer(); } catch {}
  }
  const m = /width="([\d.]+)" height="([\d.]+)" viewBox="([^"]+)"/.exec(shots[0].svg!)!;
  assert.equal(Number(m[1]), 100);
  assert.equal(Number(m[2]), 50);
  assert.equal(m[3], "0 0 100 50");
});
