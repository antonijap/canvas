import { center, NT, sc } from './harness.ts';

sc('context-actions', 'context canvas menu creates a component', { covers: ['create-component:menu', 'component-navigation:component'] }, async (t: NT) => {
  await t.showPage('layout');
  await t.look(0, 0);
  await t.selectIds(['r_free']);
  await t.click(center(await t.rect('r_free')), { right: true });
  const items = (await t.cmd('qa.menu')).items as { title: string; enabled: boolean }[];
  t.ok(items.some(i => i.title === 'Create Component' && i.enabled), 'Create Component on an ordinary layer');
  await t.pickMenu('Create Component');
  await t.waitDisk(() => t.node('r_free')?.reusable === true, 'menu created a component');
  await t.click(center(await t.rect('r_free')), { right: true });
  const componentItems = (await t.cmd('qa.menu')).items as { title: string }[];
  t.ok(!componentItems.some(i => i.title === 'Create Component'), 'no creation on a main component');
  await t.cmd('qa.menu', { cancel: true });
});

sc('context-actions', 'context inspector button and layer row create components on their targets', { covers: ['create-component:inspector', 'create-component:menu', 'duplicate:board'] }, async (t: NT) => {
  await t.section('Layers');
  await t.showPage('layout');
  await t.look(0, 0);
  await t.selectIds(['r_free']);
  await t.click(center(await t.mark({ id: 'create-component', label: 'Create Component' })));
  await t.waitDisk(() => t.node('r_free')?.reusable === true, 'inspector created component');
  await t.key('z', ['cmd']);
  await t.waitDisk(() => t.node('r_free')?.reusable !== true, 'undo inspector action');
  await t.selectIds(['fr_outer']);
  await t.click(center((await t.layerRow('r_free')).r), { right: true });
  await t.pickMenu('Create Component');
  await t.waitDisk(() => t.node('r_free')?.reusable === true, 'right-clicked row became component');
  t.ok(t.node('fr_outer')?.reusable !== true, 'previous selection stayed ordinary');
  await t.click(center((await t.layerRow('fr_outer')).r), { right: true });
  const items = (await t.cmd('qa.menu')).items as { title: string }[];
  for (const title of ['Duplicate', 'Group', 'Reveal on Canvas']) t.ok(items.some(i => i.title === title), title);
  await t.pickMenu('Reveal on Canvas');
  await t.waitState(s => s.selection?.id === 'fr_outer', 'revealed layer selected');
});

sc('context-actions', 'context instance detach and component sidebar actions', { covers: ['create-component:menu', 'component-navigation:instance', 'component-navigation:component'] }, async (t: NT) => {
  await t.section('Layers');
  await t.showPage('components');
  await t.look(600, 0);
  await t.selectIds(['inst_text']);
  await t.click(center(await t.rect('inst_text')), { right: true });
  const items = (await t.cmd('qa.menu')).items as { title: string }[];
  t.ok(!items.some(i => i.title === 'Create Component'), 'instance cannot create component');
  await t.pickMenu('Detach Instance');
  await t.waitDisk(() => t.node('inst_text')?.type !== 'ref', 'detached instance');
  await t.key('z', ['cmd']);
  await t.waitDisk(() => t.node('inst_text')?.type === 'ref', 'undo detach');
  await t.section('Components');
  await t.click(await t.textAt('Button/Primary', { x: 60, y: 60, w: 250, h: 500 }), { right: true });
  await t.pickMenu('Select All Instances');
  await t.waitState(s => s.selection?.ids?.includes('inst_text'), 'instances selected');
  await t.click(await t.textAt('Button/Primary', { x: 60, y: 60, w: 250, h: 500 }), { right: true });
  await t.pickMenu('Go to Main Component');
  await t.waitState(s => s.selection?.id === 'cmp_button', 'main component selected');
});

sc('context-actions', 'context card menus duplicate delete and refresh live widgets', { covers: ['duplicate:card-note', 'delete:card-note', 'duplicate:card-shader', 'delete:card-video'] }, async (t: NT) => {
  await t.section('Layers');
  await t.showPage('cards');
  await t.look(-20, -20, 0.6, 40);
  for (const kind of ['note', 'shader', 'video', 'posthog']) {
    const card = t.widgets().widgets.find((w: any) => w.kind === kind);
    t.ok(card, `${kind} fixture`);
    const r = await t.rect(`widget:${card.id}`);
    await t.click({ x: r.x + 20, y: r.y + 12 }, { right: true });
    const items = (await t.cmd('qa.menu')).items as { title: string; enabled: boolean }[];
    t.ok(items.some(i => i.title === 'Duplicate' && i.enabled), `${kind} duplicates`);
    t.ok(items.some(i => i.title === 'Delete' && i.enabled), `${kind} deletes`);
    t.eq(items.some(i => i.title === 'Refresh'), kind === 'posthog', 'refresh only for live data');
    const count = t.widgets().widgets.length;
    await t.pickMenu('Duplicate');
    await t.waitDisk(() => t.widgets().widgets.length === count + 1, 'card duplicated');
    await t.key('z', ['cmd']);
    await t.waitDisk(() => t.widgets().widgets.length === count, 'undo duplicate');
    const again = await t.rect(`widget:${card.id}`);
    await t.click({ x: again.x + 20, y: again.y + 12 }, { right: true });
    await t.pickMenu('Delete');
    await t.waitDisk(() => t.widgets().widgets.length === count - 1, 'card deleted');
    await t.key('z', ['cmd']);
    await t.waitDisk(() => t.widgets().widgets.length === count, 'undo delete');
  }
});

sc('context-actions', 'context board menu moves a board to another page', { covers: ['pages:board', 'duplicate:board'] }, async (t: NT) => {
  await t.section('Layers');
  await t.showPage('layout');
  await t.look(0, 0);
  await t.selectIds(['lay_nest']);
  const r = await t.rect('lay_nest');
  await t.click({ x: r.x + 20, y: r.y + 8 }, { right: true });
  const items = (await t.cmd('qa.menu')).items as { title: string }[];
  for (const title of ['Rename', 'Duplicate', 'Create Component', 'Lock', 'Hide', 'Move to Page']) t.ok(items.some(i => i.title === title), title);
  const pages = (await t.state()).pages;
  const target = pages.find((p: any) => p.id === 'components');
  await t.pickMenu(`Move to Page > ${target.name}`);
  await t.waitState(s => !s.boards.includes('lay_nest'), 'board left current page');
  await t.showPage('components');
  await t.waitState(s => s.boards.includes('lay_nest'), 'board arrived on target page');
});

sc('context-actions', 'context Cloud file card opens using its existing action', { covers: ['cloud-files:open'] }, async (t: NT) => {
  const post = async (p: string, body: unknown) => {
    const r = await fetch(t.app.base + p, { method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, j: await r.json() as any };
  };
  await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
  const host = await post('/api/cloud/host/start', { name: 'Studio', label: 'Anna' });
  t.eq(host.status, 200, 'host starts');
  try {
    await t.cmd('qa.cloud', { clouds: [{ url: host.j.url, name: 'Studio' }] });
    await t.key('0', ['cmd', 'shift']);
    await t.waitState(s => s.homeShown, 'Home');
    await t.click(center(await t.mark({ id: 'home-row', label: 'Studio' }, 8000)));
    await t.mark({ id: 'cloud-files-new' });
    await t.key('n', ['cmd']);
    const opened = await t.waitState(s => s.file?.includes('/cloud-files/') && !s.homeShown, 'new Cloud file');
    await t.key('0', ['cmd', 'shift']);
    await t.click(center(await t.mark({ id: 'home-row', label: 'Studio' })));
    await t.click(center(await t.mark({ id: 'cloud-file', label: 'Untitled' }, 8000)), { right: true });
    await t.pickMenu('Open');
    await t.waitState(s => s.file === opened.file && !s.homeShown, 'card menu opened file');
  } finally {
    await post('/api/cloud/host/stop', { hostId: host.j.hostId });
    await post('/api/cloud/host/wipe', { hostId: host.j.hostId });
    await t.cmd('qa.cloud', { clouds: [] });
  }
});
