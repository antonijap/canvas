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

test('bottom overlays clear the tool palette even when zoom stays at the window edge', () => {
  const zoom = { left: 586, bottom: 790, height: 40 };
  const area = bottomOverlayArea(720, 800, { l: 236, r: 304 }, zoom, 40, 10, 10, 72);
  assert.equal(area.x, 326);
  assert.equal(area.y + 20, 728);
});

test('bottom overlays clear the taller raised zoom island and center beside zoom when it is alone', () => {
  const zoom = { left: 302, bottom: 328, height: 68 };
  const stacked = bottomOverlayArea(720, 420, { l: 258, r: 294 }, zoom, 40, 10, 10, 170);
  assert.equal(stacked.y + 20, zoom.bottom - zoom.height - 10);
  assert.equal(stacked.aboveZoom, true);

  const viewerZoom = { left: 586, bottom: 406, height: 36 };
  const viewer = bottomOverlayArea(720, 420, { l: 0, r: 10 }, viewerZoom, 40);
  assert.equal(viewer.y, viewerZoom.bottom - viewerZoom.height / 2);
  assert.equal(viewer.x + viewer.width / 2, viewerZoom.left - 10);
});

test('native overlay listener requests geometry after it is ready', async () => {
  const { readFileSync } = await import('node:fs');
  const { runInNewContext } = await import('node:vm');
  const listeners = new Map<string, (c: unknown) => void>();
  const messages: unknown[] = [];
  const context = {
    requestAnimationFrame: () => 1,
    addEventListener: () => {},
    MutationObserver: class { observe() {} },
    document: { body: {} },
    host: {
      native: true,
      on: (event: string, listener: (c: unknown) => void) => listeners.set(event, listener),
      post: (message: unknown) => {
        assert.ok(listeners.has('cmd'), 'commands must be heard before asking for the cached frame');
        messages.push(message);
      },
    },
  };
  const source = readFileSync(new URL('../src/page/bottom-overlays.js', import.meta.url), 'utf8');
  runInNewContext(source.replaceAll('export function', 'function') + '\ninstallBottomOverlays(host);', context);
  assert.equal(JSON.stringify(messages), JSON.stringify([{ bottomOverlayReady: true }]));
});

test('bottom overlays stay inside the docked panels when zoom fills the gap', () => {
  const area = bottomOverlayArea(720, 800, { l: 306, r: 294 }, { left: 290, bottom: 790, height: 40 }, 40);
  assert.equal(area.x, 366);
  assert.ok(area.x - area.width / 2 >= 306 && area.x + area.width / 2 <= 426);
  assert.ok(area.y + 20 < 750, 'the notices clear the zoom pill');
});

test('bottom overlays move above zoom when the comment controls need more width', () => {
  const area = bottomOverlayArea(900, 420, { l: 248, r: 294 }, { left: 477, bottom: 410, height: 40 }, 40, 10, 10, 0, 210);
  assert.equal(area.x, 427);
  assert.equal(area.width, 338);
  assert.ok(area.y + 20 < 370, 'the full comment pill clears zoom');
});

test('the comments bar sits at the top, not in the bottom stack with the tool palette', async () => {
  const fs = await import('node:fs');
  const source = fs.readFileSync(new URL('../src/page/bottom-overlays.js', import.meta.url), 'utf8');
  const stack = source.slice(source.indexOf('const selectors'), source.indexOf('];', source.indexOf('const selectors')));
  assert.ok(!stack.includes('.cm-bar'));
  assert.ok(source.includes("set('top', ((host.insets && host.insets.t) || 0) + inset + 'px')"));
});
