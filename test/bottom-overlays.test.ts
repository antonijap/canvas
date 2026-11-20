import { test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore browser module
import { bottomOverlayArea } from '../src/page/bottom-overlays.js';
test('bottom overlays center within free canvas at the zoom vertical center', () => {
  for (const width of [720, 1280, 1800]) {
    const area = bottomOverlayArea(width, 800, { l: 80, r: 280 }, { left: width - 148, bottom: 782 });
    assert.equal(area.x, (80 + width - 280)/2);
    assert.equal(area.y, 764);
    assert.ok(area.x + area.width/2 < width - 148);
  }
});
