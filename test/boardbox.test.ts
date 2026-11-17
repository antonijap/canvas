// The box the page loads boards by (src/boardbox.ts), the same function the page script embeds.

import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { loadBox } from "../src/boardbox.ts";

// The page's own test, with its prefetch margin: does the box touch the view?
const PREFETCH = 0.6;
function wantsLoad(box: { x: number; y: number; w: number; h: number }, cam: { x: number; y: number; z: number }, vw: number, vh: number) {
  const L = -vw * PREFETCH, T = -vh * PREFETCH, R = vw * (1 + PREFETCH), B = vh * (1 + PREFETCH);
  const sx = box.x * cam.z + cam.x, sy = box.y * cam.z + cam.y;
  return sx < R && sx + box.w * cam.z > L && sy < B && sy + box.h * cam.z > T;
}

describe("loadBox", () => {
  // "Holiday offers 10 Oct": fit_content, 2962 x 4054 once laid out, top-left at (16678, 20754).
  const meta = { id: "qgLJq", x: 16678, y: 20754 };
  // A reveal at 100% into its lower right in a 1512 x 803 view: the top-left corner is far above and left.
  const cam = { z: 1, x: Math.round(1512 / 2 - (16678 + 2962 * 0.7)), y: Math.round(803 / 2 - (20754 + 4054 * 0.7)) };

  test("an unmeasured board of unknown size is loaded when its body may fill the view", () => {
    // Regression: the 400 px stand-in box was tested, the board never loaded and the view stayed blank.
    assert.equal(wantsLoad({ x: meta.x, y: meta.y, w: 400, h: 400 }, cam, 1512, 803), false, "the old box misses the view");
    assert.equal(wantsLoad(loadBox(meta, 400, 400, false), cam, 1512, 803), true);
  });

  test("a measured board is tested at its real size", () => {
    assert.deepEqual(loadBox(meta, 2962, 4054, true), { x: 16678, y: 20754, w: 2962, h: 4054 });
    assert.equal(wantsLoad(loadBox(meta, 2962, 4054, true), cam, 1512, 803), true);
    // Measured and far away: not loaded.
    assert.equal(wantsLoad(loadBox(meta, 2962, 4054, true), { z: 1, x: 0, y: 0 }, 1512, 803), false);
  });

  test("a size the document gives is trusted; only the unknown side is stretched", () => {
    assert.deepEqual(loadBox({ x: 0, y: 0, width: 390, height: 844 }, 390, 844, false), { x: 0, y: 0, w: 390, h: 844 });
    assert.deepEqual(loadBox({ x: 0, y: 0, width: 1387 }, 1387, 400, false), { x: 0, y: 0, w: 1387, h: 10000 });
    assert.deepEqual(loadBox({ x: 5, y: 6 }, 400, 400, false, 3000), { x: 5, y: 6, w: 3000, h: 3000 });
  });

  test("it does not reach up or left: boards below and right of the view stay unloaded", () => {
    assert.equal(wantsLoad(loadBox({ x: 5000, y: 5000 }, 400, 400, false), { z: 1, x: 0, y: 0 }, 1512, 803), false);
  });
});
