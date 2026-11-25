import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT, gradientPng, noisePng, startServer } from '../lib.ts';
import { decodePng } from '../../src/export.ts';
import { center, NT, sc } from './harness.ts';

sc('canvas-menu-png', 'Canvas context menu copies decodable 2x PNGs', { covers: ['copy-as:png', 'copy-as:one', 'copy-as:many', 'copy-as:board', 'copy-as:menu'] }, async (t: NT) => {
  await t.cmd('close', { file: t.file });
  const doc = t.disk();
  const largeBoard = doc.children.find(node => node.id === 'lay_nest')!;
  Object.assign(largeBoard, {
    width: 1000, height: 1000,
    fill: { type: 'image', url: 'media/copy-png-noise.png', mode: 'fill' },
  });
  fs.writeFileSync(path.join(t.file, 'media', 'copy-png-noise.png'), noisePng(2000, 2000));
  fs.writeFileSync(path.join(t.file, 'document.json'), JSON.stringify(doc));
  await t.app.openShown(t.file);
  await t.waitState(s => s.file === t.file && s.pages.length > 0, 'the updated board document to open');
  await t.showPage('layout');
  await t.look(0, 0);
  const board = await t.rect('lay_nest');
  const free = center(await t.rect('r_free'));
  const cases = [
    { ids: ['lay_nest'], point: { x: board.x + 20, y: board.y + 8 }, size: [2000, 2000] },
    { ids: ['r_free'], point: free, size: [140, 100] },
    { ids: ['fr_inner', 'r_free'], point: free, size: [644, 532] },
  ];
  for (const { ids, point, size } of cases) {
    await t.selectIds(ids);
    await t.cmd('qa.pasteboard', { set: '' });
    await t.click(point, { right: true });
    await t.pickMenu('Copy as > Copy as PNG');
    const pb = await t.waitFor(async () => {
      const result = await t.cmd('qa.pasteboard');
      return result.pngInfo && result;
    }, `a decodable PNG for ${ids.join(', ')}`, 20_000);
    t.eq([pb.pngInfo.width, pb.pngInfo.height], size, 'selection at 2x');
    if (ids.includes('lay_nest')) t.ok(pb.pngInfo.bytes > 2 * 1024 * 1024, 'the board PNG exceeds 2 MiB');
    t.ok(pb.types.includes('public.png'), 'PNG on the pasteboard');
    t.ok(pb.types.includes('public.tiff'), 'TIFF on the pasteboard');
    const file = path.join(t.app.dir, 'copied.png');
    await t.cmd('qa.pasteboard', { pngTo: file });
    const png = decodePng(fs.readFileSync(file));
    t.eq(png.channels === 4 ? png.data[3] : 255, 0, `outside the rounded corner is transparent for ${ids.join(', ')}`);
    const inside = (png.width * 12 + 12) * png.channels;
    t.ok(png.channels === 3 || png.data[inside + 3] > 0, 'the selection itself is drawn');
  }
});

sc('canvas-menu-move', 'Canvas context menu moves all selected boards', { covers: ['pages:board'] }, async (t: NT) => {
  await t.showPage('layout');
  await t.look(0, 0);
  await t.selectIds(['lay_nest', 'lay_auto']);
  const r = await t.rect('lay_nest');
  await t.click({ x: r.x + 20, y: r.y + 8 }, { right: true });
  const target = (await t.state()).pages.find((p: any) => p.id === 'components');
  await t.pickMenu(`Move to Page > ${target.name}`);
  await t.waitState(s => !s.boards.includes('lay_nest') && !s.boards.includes('lay_auto'), 'both boards left the source page');
  await t.showPage('components');
  await t.waitState(s => s.boards.includes('lay_nest') && s.boards.includes('lay_auto'), 'both boards arrived on target page');
});

sc('canvas-menu-layout', 'Canvas context menu removes auto layout from a mixed selection', { covers: [] }, async (t: NT) => {
  await t.showPage('layout');
  await t.look(245, 0);
  await t.rect('al_row');
  await t.selectIds(['al_row', 'r_free']);
  await t.click(center(await t.rect('r_free')), { right: true });
  await t.pickMenu('Remove auto layout');
  await t.waitDisk(() => t.node('al_row')?.layout === 'none', 'the auto layout frame becomes freeform');
});

sc('canvas-menu-fit-content', 'Canvas context menu fits the clicked frame within a multi-selection', { covers: [] }, async (t: NT) => {
  await t.showPage('layout');
  await t.look(0, 0);
  await t.selectIds(['fr_outer', 'r_free']);
  const r = await t.rect('fr_outer');
  await t.click({ x: r.x + 10, y: r.y + 10 }, { right: true });
  await t.pickMenu('Resize to fit content');
  const fitted = await t.waitDisk(() => {
    const frame = t.node('fr_outer');
    return frame?.width === 130 && frame;
  }, 'the clicked frame resized');
  t.eq([fitted.x, fitted.y, fitted.width, fitted.height], [48, 84, 130, 90], 'the frame fits its child');
  t.eq([t.node('fr_inner')?.x, t.node('fr_inner')?.y], [0, 0], 'the child stays in the same place on the canvas');
  t.eq([t.node('r_free')?.width, t.node('r_free')?.height], [70, 50], 'the other selected layer keeps its size');
  await t.waitState(s => s.selection?.ids?.length === 2, 'both layers stay selected');
});

sc('canvas-menu-ungroup', 'Canvas context menu disables Ungroup for main components', { covers: [] }, async (t: NT) => {
  await t.showPage('components');
  await t.look(0, 0);
  await t.selectIds(['cmp_button']);
  await t.click(center(await t.rect('cmp_button')), { right: true });
  const item = (await t.cmd('qa.menu')).items.find((i: any) => i.title === 'Ungroup');
  t.eq(item?.enabled, false, 'a main component cannot be ungrouped');
  await t.cmd('qa.menu', { cancel: true });
  await t.showPage('layout');
  await t.look(0, 0);
  await t.selectIds(['g_pair', 'r_free']);
  await t.click(center(await t.rect('r_free')), { right: true });
  await t.pickMenu('Ungroup');
  await t.waitDisk(() => !t.node('g_pair') && t.node('r_g1') && t.node('r_free'), 'the ordinary group ungrouped');
});

sc('canvas-menu-unlock', 'Canvas context menu unlocks a selected locked layer', { covers: ['lock:rectangle'] }, async (t: NT) => {
  await t.showPage('layout');
  await t.look(0, 0);
  await t.selectIds(['r_free']);
  const point = center(await t.rect('r_free'));
  await t.click(point, { right: true });
  await t.pickMenu('Lock');
  await t.waitDisk(() => t.node('r_free')?.locked === true, 'the layer locked');
  await t.settle();
  await t.click(point, { right: true });
  await t.pickMenu('Unlock');
  await t.waitDisk(() => t.node('r_free')?.locked !== true, 'the layer unlocked');
});

sc('canvas-menu-paste-image', 'Canvas context menu pastes an image at the pointer', { covers: ['image-paste:in-frame'] }, async (t: NT) => {
  await t.showPage('layout');
  await t.look(0, 0);
  await t.selectIds(['lay_nest']);
  const r = await t.rect('lay_nest');
  await t.cmd('qa.pasteboard', { png: gradientPng(40, 30).toString('base64') });
  await t.click({ x: r.x + 240, y: r.y + 250 }, { right: true });
  await t.pickMenu('Paste here');
  const image = await t.waitDisk(() => t.node('lay_nest')?.children?.find(n => n.name === 'Pasted image'), 'the image to paste into the board');
  t.eq([image.x, image.y, image.width, image.height], [220, 235, 40, 30], 'the image is centered at the pointer');
});

sc('canvas-menu-copy-metadata', 'Canvas context menu copies the clicked layer ID and name', { covers: [] }, async (t: NT) => {
  await t.showPage('layout');
  await t.look(0, 0);
  await t.selectIds(['r_free']);
  const point = center(await t.rect('r_free'));
  for (const [title, value] of [['Copy ID', 'r_free'], ['Copy name', 'Free rect']]) {
    await t.cmd('qa.pasteboard', { set: '' });
    await t.click(point, { right: true });
    await t.pickMenu(title);
    t.eq((await t.cmd('qa.pasteboard')).text, value, title);
  }
});

sc('canvas-menu-copy-text', 'Canvas context menu copies text from a board and multiple layers', { covers: ['copy-as:board', 'copy-as:many', 'copy-as:text'] }, async (t: NT) => {
  await t.showPage('layout');
  await t.look(0, 0);
  const r = await t.rect('lay_nest');
  const text = t.node('lay_nest_cap')?.content;
  t.ok(typeof text === 'string' && text.length > 0, 'board fixture has a caption');
  for (const { ids, point } of [
    { ids: ['lay_nest'], point: { x: r.x + 20, y: r.y + 8 } },
    { ids: ['lay_nest_cap', 'r_free'], point: center(await t.rect('r_free')) },
  ]) {
    await t.selectIds(ids);
    await t.cmd('qa.pasteboard', { set: '' });
    await t.click(point, { right: true });
    await t.pickMenu('Copy as > Copy as text');
    await t.waitFor(async () => (await t.cmd('qa.pasteboard')).text === text, 'the board caption on the pasteboard');
  }
});

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
  await t.section('Assets');
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
  const post = async (p: string, body: unknown, base = t.app.base) => {
    const r = await fetch(base + p, { method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) });
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

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-card-editor-'));
    let remote: Awaited<ReturnType<typeof startServer>> | undefined;
    try {
      remote = await startServer(dir, {
        HOME: dir, CANVAS_STATE_DIR: path.join(dir, 'state'), CANVAS_CLOUD_SECRETS_FILE: path.join(dir, 'secrets.json'),
        CANVAS_COMMENT_NAME: 'Owner', CANVAS_TUNNEL_BIN: path.join(ROOT, 'test/fixtures/fake-tunnel.sh'),
        CANVAS_FAKE_TUNNEL_DIR: path.join(t.app.dir, 'tunnels'), CANVAS_FAKE_TUNNEL_NODE: process.execPath, CANVAS_FAKE_TUNNEL_ANY_PORT: '1',
      });
      const team = await post('/api/cloud/host/start', { name: 'Team', label: 'Owner' }, remote.base);
      t.eq(team.status, 200, 'second Cloud starts');
      const cloud = team.j.url;
      t.eq((await post('/api/cloud/files/create', { cloud, name: 'Owner file' }, remote.base)).status, 201, 'owner creates a file');
      const invite = await post('/api/cloud/host/invite', { hostId: team.j.hostId, label: 'Editor', role: 'editor' }, remote.base);
      t.eq(invite.status, 200, 'editor invited');
      t.eq((await post('/api/cloud/join', { link: invite.j.link, device: 'Editor device' })).status, 200, 'editor joins');
      t.eq((await post('/api/cloud/files/create', { cloud, name: 'Editor file' })).status, 201, 'editor creates a file');
      const { clouds: [teamEntry] } = await t.cmd('qa.cloud', { clouds: [{ url: cloud, name: 'Team' }] });
      await t.click(center(await t.mark({ id: 'home-tab' })));
      await t.cmd('qa.cloud', { home: teamEntry.id });
      for (const [name, canDelete] of [['Owner file', false], ['Editor file', true]] as const) {
        await t.click(center(await t.mark({ id: 'cloud-file', label: name, exact: true }, 8000)), { right: true });
        const menu = (await t.cmd('qa.menu')).items as { title: string; enabled: boolean }[];
        t.eq(menu.find(item => item.title === 'Delete')?.enabled, canDelete, `editor Delete on ${name}`);
        t.eq(menu.find(item => item.title === 'Rename')?.enabled, true, `editor Rename on ${name}`);
        await t.cmd('qa.menu', { cancel: true });
      }
    } finally {
      await remote?.stop();
      fs.rmSync(dir, { recursive: true, force: true });
    }
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

sc('board-title-menu', 'Right-click on a board title opens the board menu, not the empty canvas one', { covers: [] }, async (t: NT) => {
  await t.showPage('layout');
  const at = await t.js(`const el=[...document.querySelectorAll('#labels>div')].find(d=>{const r=d.getBoundingClientRect();return getComputedStyle(d).display!=='none'&&r.width>30&&r.top>40&&r.left>40&&r.right<innerWidth-40});if(!el)return null;const r=el.getBoundingClientRect(),x=Math.round(r.left+10),y=Math.round(r.top+r.height/2);return {x,y,id:window.canvasHost.titleAt(x,y)}`);
  t.ok(at && at.id, 'a board title is on screen');
  await t.click({x: at.x, y: at.y}, {right:true});
  const items = (await t.cmd('qa.menu')).items.map((i: {title:string}) => i.title);
  t.ok(items.includes('Export as PNG'), 'board menu has Export as PNG');
  t.ok(!items.includes('New Board here'), 'not the empty canvas menu');
  await t.cmd('qa.menu', { cancel: true });
  t.eq(await t.pageSel(), [at.id], 'the board is selected');
});

sc('empty-canvas-menu', 'Empty canvas menu creates a board at the click', { covers: ['board-create:context-menu'] }, async (t: NT) => {
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
