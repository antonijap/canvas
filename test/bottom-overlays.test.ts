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
  const area = bottomOverlayArea(720, 800, { l: 236, r: 304 }, zoom, 40, 72);
  assert.equal(area.x, 326);
  assert.equal(area.y + 20, 728);
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
