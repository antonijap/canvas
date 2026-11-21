import { sc, T } from './harness.ts';

sc('context-actions', 'context card right click selects the target and posts a native menu', { covers: ['duplicate:card-note', 'delete:card-note'], skip: { visual: 'Checks native bridge menu data; the native scenario captures the rendered app.' } }, async (t: T) => {
  await t.showPage('cards');
  const card = t.widget('note');
  const result = await t.ev(`(async () => {
    const h = window.canvasHost, messages = [];
    const old = { native: h.native, post: h.post };
    h.native = true; h.post = m => messages.push(m);
    try {
      const card = document.querySelector('[data-id="widget:${card.id}"]');
      card.dispatchEvent(new MouseEvent('contextmenu', { clientX: 400, clientY: 300, bubbles: true, cancelable: true }));
      await new Promise(r => setTimeout(r, 100));
      return { context: messages.find(m => m.context)?.context, ids: h.selection() };
    } finally { Object.assign(h, old); h.setSelection([]); }
  })()`);
  t.eq(result.context?.target?.kind, 'card', 'card menu posted');
  t.eq(result.context?.target?.id, `widget:${card.id}`, 'right-click target');
  t.eq(result.ids, [`widget:${card.id}`], 'card selected');
});

sc('context-actions', 'context Delete command removes a lone card and undo restores it', { covers: ['delete:card-note'], skip: { visual: 'Checks command dispatch and persisted card history; native QA captures card rendering.' } }, async (t: T) => {
  await t.showPage('cards');
  const card = t.widget('note');
  const count = t.widgets().widgets.length;
  await t.ev(`window.canvasHost.selectId('widget:${card.id}'); window.canvasCmd({cmd:'structure',op:'delete'});`);
  await t.flush();
  t.eq(t.widgets().widgets.length, count - 1, 'card deleted');
  await t.undo();
  t.eq(t.widgets().widgets.length, count, 'undo restored card');
});
