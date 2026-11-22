import assert from "node:assert/strict";
import test from "node:test";
// @ts-expect-error: a browser module without types
import { imageOverviewBoard, localJpegPath } from "../src/page/image-overview.js";

const url = "/asset?p=%2Fmedia%2Fscreen%20one.jpg";
const image = { id: "image", type: "rectangle", x: 10, y: 10, width: 100, height: 200, fill: [{ type: "image", url, mode: "fill" }] };
const frame = { id: "frame", type: "frame", width: 120, height: 220, fill: "#FFFFFF", clip: true, cornerRadius: 12, children: [image] };

test("the fit compositor accepts local single-image rectangles in a clipped fixed frame", () => {
  assert.equal(localJpegPath(url), "/media/screen one.jpg");
  assert.deepEqual(imageOverviewBoard(frame), {
    w: 120, h: 220, radius: 12, fill: "#FFFFFF", clip: true,
    rects: [{ x: 10, y: 10, w: 100, h: 200, radius: 0, url }],
  });
});

test("fall back to the full renderer for layouts, effects or paints the fit compositor cannot reproduce", () => {
  assert.equal(imageOverviewBoard({ ...frame, layout: "horizontal" }), null);
  assert.equal(imageOverviewBoard({ ...frame, effect: [] }), null);
  const board = (changes: object) => ({ ...frame, children: [{ ...image, ...changes }] });
  assert.equal(imageOverviewBoard(board({ rotation: 15 })), null);
  assert.equal(imageOverviewBoard(board({ fill: [{ ...image.fill[0], url: url + "#adjust=1" }] })), null);
  assert.equal(imageOverviewBoard(board({ fill: [{ ...image.fill[0], mode: "tile" }] })), null);
  assert.equal(imageOverviewBoard({ ...board({ x: -10 }), clip: false }), null);
});
