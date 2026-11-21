import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const source = fs.readFileSync(new URL('../src/page/context.js', import.meta.url), 'utf8').replace('import { usageFocus } from "./geometry.js";', '');

async function menu(leaf: string | null, selection: string[], nodes: Record<string, Record<string, unknown>>, card?: string) {
  let handler: (e: unknown) => Promise<void>;
  const messages: any[] = [];
  let selected = [...selection];
  const host = {
    file: 'fixture.canvas', native: true,
    view: { addEventListener: (_: string, cb: typeof handler) => { handler = cb; } },
    pick: () => leaf, chainOf: () => [leaf], pickSelectable: () => leaf,
    selection: () => selected, selectId: (id: string) => { selected = [id]; },
    api: (p: string) => p + '?file=fixture.canvas', on: () => {},
    post: (m: any) => messages.push(m),
  };
  const fetch = async (url: string) => {
    const u = new URL(url, 'http://localhost');
    const id = u.searchParams.get('id')!;
    return { ok: true, json: async () => u.pathname === '/api/node' ? { node: nodes[id] } : { id, kind: 'node', type: nodes[id]?.type } };
  };
  new Function('window', 'fetch', source)({ canvasHost: host }, fetch);
  await handler!({ preventDefault() {}, clientX: 20, clientY: 30, target: { closest: () => card ? { dataset: { id: card } } : null } });
  return { context: messages.find(m => m.context)?.context, selected };
}

test('card menu selects an unselected card and preserves a selected multi-selection', async () => {
  const first = await menu('widget:video', ['other'], {});
  assert.equal(first.context.target.kind, 'card');
  assert.deepEqual(first.selected, ['widget:video']);
  const multi = await menu('widget:shader', ['widget:shader', 'widget:note'], {});
  assert.deepEqual(multi.selected, ['widget:shader', 'widget:note']);
});

test('component menu eligibility excludes instances, main components and instance descendants', async () => {
  for (const node of [{ type: 'ref' }, { type: 'frame', reusable: true }]) {
    assert.equal((await menu('a', ['a'], { a: node })).context.target.canCreateComponent, false);
  }
  assert.equal((await menu('a', ['a'], { a: { type: 'rectangle' } })).context.target.canCreateComponent, true);
  assert.equal((await menu('a/child', ['a/child'], {})).context.target.canCreateComponent, false);
  const multi = await menu('a', ['a', 'b'], { a: { type: 'ref' }, b: { type: 'text' } });
  assert.equal(multi.context.target.canCreateComponent, true);
  assert.deepEqual(multi.selected, ['a', 'b']);
});

test('menu labels reflect all selected layers being hidden or locked', async () => {
  const { context } = await menu('a', ['a', 'b'], { a: { type: 'text', locked: true, enabled: false }, b: { type: 'text', locked: true, enabled: false } });
  assert.equal(context.target.locked, true);
  assert.equal(context.target.hidden, true);
});

test('cards use the DOM target when the engine hit test skips their overlay', async () => {
  const { context, selected } = await menu(null, [], {}, 'widget:note');
  assert.equal(context.target.kind, 'card');
  assert.deepEqual(selected, ['widget:note']);
});
