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

sc('context-actions', 'context Cloud file card opens, copies a link and duplicates on the host', { covers: ['cloud-files:open'] }, async (t: NT) => {
  const post = async (p: string, body: unknown) => {
    const r = await fetch(t.app.base + p, { method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, j: await r.json() as any };
  };
  await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
  const host = await post('/api/cloud/host/start', { name: 'Studio', label: 'Anna' });
  t.eq(host.status, 200, 'host starts');
  try {
    const { clouds: [entry] } = await t.cmd('qa.cloud', { clouds: [{ url: host.j.url, name: 'Studio' }] });
    await t.key('0', ['cmd', 'shift']);
    await t.waitState(s => s.homeShown, 'Home');
    await t.click(center(await t.mark({ id: 'home-row', label: 'Studio' }, 8000)));
    await t.mark({ id: 'cloud-files-new' });
    await t.key('n', ['cmd']);
    const opened = await t.waitState(s => s.file?.includes('/cloud-files/') && !s.homeShown, 'new Cloud file');
    await t.click(center(await t.mark({ id: 'home-tab' })));
    await t.waitState(s => s.homeShown, 'back to Home after creating the file');
    await t.cmd('qa.cloud', { home: entry.id });
    await t.waitState(s => s.homeSection === 'cloud', 'Cloud selected in Home');
    const cardMenu = async (name = 'Untitled') => {
      const card = await t.mark({ id: 'cloud-file', label: name, exact: true }, 8000).catch(async error => {
        const s = await t.state();
        const response = await fetch(t.app.base + '/api/cloud/files?cloud=' + encodeURIComponent(host.j.url));
        const listed = await response.json() as { files?: { name: string }[] };
        throw new Error(`${error.message}; Home ${s.homeShown}, section ${s.homeSection}, Cloud listing ${response.status} ${JSON.stringify(listed.files?.map(file => file.name))}`);
      });
      await t.click(center(card), { right: true });
    };
    await cardMenu();
    const items = (await t.cmd('qa.menu')).items.map((item: { title: string }) => item.title);
    t.eq(items, ['Open', 'Duplicate', 'Rename', 'Copy Link', 'Download a Local Copy', 'Delete'], 'Cloud file actions');
    await t.pickMenu('Copy Link');
    t.ok((await t.state()).homeShown, 'copying the card link leaves Home open');
    const link = new URL((await t.cmd('qa.pasteboard')).text);
    t.eq(link.searchParams.get('cloudFile'), opened.file.split('/').at(-1).replace(/\.canvas$/, ''), 'link names the Cloud file');
    t.ok(/^[0-9a-f]{16}$/.test(link.searchParams.get('cloud') ?? ''), 'link uses the Cloud identifier');
    await cardMenu();
    await t.pickMenu('Duplicate');
    await cardMenu('Untitled copy');
    await t.pickMenu('Download a Local Copy');
    t.ok((await t.state()).panels.includes('Download a Local Copy'), 'download asks for a local file');
    await cardMenu();
    await t.pickMenu('Open');
    await t.waitState(s => s.file === opened.file && !s.homeShown, 'card menu opened file');
  } finally {
    await post('/api/cloud/host/stop', { hostId: host.j.hostId });
    await post('/api/cloud/host/wipe', { hostId: host.j.hostId });
    await t.cmd('qa.cloud', { clouds: [] });
  }
});

sc('layer-row-menu', 'Layer menu selects children, copies the clicked link and deletes with undo', { covers: [] }, async (t: NT) => {
  await t.section('Layers');
  await t.showPage('layout');
  await t.selectIds(['r_free']);
  const clickRow = async (id: string) => t.click(center((await t.layerRow(id)).r), { right: true });
  await clickRow('fr_outer');
  await t.pickMenu('Copy Link to Layer');
  t.ok((await t.cmd('qa.pasteboard')).text.includes('node=fr_outer'), 'link points to the clicked layer');
  await clickRow('fr_outer');
  await t.pickMenu('Select Children');
  await t.waitState(s => s.selection?.id === 'fr_inner', 'children are selected');
  await clickRow('r_free');
  await t.pickMenu('Delete');
  await t.waitDisk(() => !t.node('r_free'), 'right-clicked layer deleted');
  await t.key('z', ['cmd']);
  await t.waitDisk(() => !!t.node('r_free'), 'undo restores the layer');
});

sc('inspector-value-menu', 'Inspector menus copy, paste and reset a rotation and paste a color', { covers: [] }, async (t: NT) => {
  await t.showPage('layout');
  await t.selectIds(['r_free']);
  const rotation = async () => center(await t.mark({id:'rotation-value'}));
  await t.cmd('qa.pasteboard', {set:'45'});
  await t.click(await rotation(), {right:true});
  await t.pickMenu('Paste Value');
  await t.waitDisk(() => t.node('r_free')?.rotation === 45, 'pasted rotation');
  await t.click(await rotation(), {right:true});
  await t.pickMenu('Copy Value');
  t.eq((await t.cmd('qa.pasteboard')).text, '45', 'copied rotation');
  await t.click(await rotation(), {right:true});
  await t.pickMenu('Reset to Default');
  await t.waitDisk(() => (t.node('r_free')?.rotation ?? 0) === 0, 'default rotation');
  const hex = await t.mark({id:'hex-value'});
  await t.cmd('qa.pasteboard', {set:'#123456'});
  await t.click(center(hex), {right:true});
  await t.pickMenu('Paste Value');
  await t.waitDisk(() => JSON.stringify(t.node('r_free')?.fill).includes('#123456'), 'pasted color');
});

sc('empty-canvas-menu', 'Empty canvas menu creates a board at the click', { covers: [] }, async (t: NT) => {
  await t.showPage('layout');
  await t.look(-1800, -1200);
  const point = {x: 780, y: 430};
  const world = await t.js(`const h=window.canvasHost,c=h.cam; return {x:Math.round((${point.x}-c.x)/c.z),y:Math.round((${point.y}-c.y)/c.z)}`);
  const previous = (await t.state()).boards as string[];
  await t.click(point, {right:true});
  const items = (await t.cmd('qa.menu')).items.map((i: {title:string}) => i.title);
  t.eq(items, ['New Board here', 'Paste here', 'Select all', 'Zoom to fit'], 'empty canvas menu');
  await t.pickMenu('New Board here');
  const state = await t.waitState(s => s.boards.length === previous.length + 1, 'new board appears on this page');
  const id = state.boards.find((id: string) => !previous.includes(id));
  t.eq([t.node(id)?.x, t.node(id)?.y], [world.x, world.y], 'board starts at the context click');
});
