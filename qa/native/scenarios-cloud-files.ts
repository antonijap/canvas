// Cloud files: real Home and editor, second Canvas driven over HTTP through the fake tunnel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { center, NT, sc } from './harness.ts';
import { startServer, ROOT, type Scratch } from '../lib.ts';
import { PLAYGROUND } from '../playground.ts';
import { expectedMove } from '../cloud-files-fixture.ts';
const post = async (base: string, p: string, b: unknown) => { const r = await fetch(base + p, { method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, j: await r.json() as any }; };

sc('cloud-files', 'Selected Cloud file draws its board on relaunch', { covers: ['cloud-files:open'] }, async (t: NT) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-native-cloud-launch-'));
    let host: Scratch | undefined;
    let file: string | undefined;
    try {
        host = await startServer(dir, {
            HOME: dir, CANVAS_STATE_DIR: path.join(dir, 'state'), CANVAS_CLOUD_SECRETS_FILE: path.join(dir, 'secrets.json'),
            CANVAS_TUNNEL_BIN: path.join(ROOT, 'test/fixtures/fake-tunnel.sh'),
            CANVAS_FAKE_TUNNEL_DIR: path.join(t.app.dir, 'tunnels'), CANVAS_FAKE_TUNNEL_NODE: process.execPath,
            CANVAS_FAKE_TUNNEL_ANY_PORT: '1', CANVAS_CLOUD_HOST_PORT: '0',
        });
        const started = await post(host.base, '/api/cloud/host/start', { name: 'Studio', label: 'Ben' });
        t.eq(started.status, 200, 'Cloud starts');
        const cloud = started.j.url;
        const made = await post(host.base, '/api/cloud/files/create', { cloud, name: 'Design' });
        t.eq(made.status, 201, 'Cloud file created');
        const added = await post(host.base, '/api/structure', {
            file: made.j.file, op: 'add', nodes: [{ id: 'StudioBoard', type: 'frame', width: 320, height: 240 }],
        });
        t.eq(added.status, 200, 'Cloud board created');
        const invite = await post(host.base, '/api/cloud/host/invite', { hostId: started.j.hostId, label: 'Anna', role: 'editor' });
        const joined = await post(t.app.base, '/api/cloud/join', { link: invite.j.link, device: 'A Mac' });
        t.eq(joined.status, 200, 'editor joins');
        await t.cmd('qa.cloud', { clouds: [{ url: cloud, name: 'Studio' }] });
        const opened = await post(t.app.base, '/api/cloud/files/open', { cloud, id: made.j.id });
        t.eq(opened.status, 200, 'editor opens the file');
        file = opened.j.file;
        await t.app.openShown(file!);
        await t.waitState(s => s.file === file && s.boards.includes('StudioBoard'), 'Cloud board before quitting');

        // Let the WebView reach the fresh server before the shell's settings post can arrive.
        let launched = 0;
        await t.app.relaunch({
            restartServer: true, env: { CANVAS_QA_SETTINGS_DELAY_MS: '1000' },
            onLaunch: () => { launched = performance.now(); },
        });
        const readPage = async () => {
            const status = await fetch(t.app.base + '/api/bridge/status', { signal: AbortSignal.timeout(500) });
            const { pages } = await status.json() as { pages: { file: string; perf?: { look?: number; doc?: number } }[] };
            return pages.find(p => p.file === file);
        };
        const page = await t.waitFor(async () => {
            const state = await readPage();
            return state?.perf?.look != null && state;
        }, 'the restored Cloud tab to report perf.look', Math.max(0, 3000 - (performance.now() - launched))).catch(async error => {
            const doc = await fetch(t.app.base + '/api/doc?file=' + encodeURIComponent(file!), { signal: AbortSignal.timeout(500) });
            t.note(`bridge perf ${JSON.stringify((await readPage())?.perf ?? null)}, GET /api/doc ${doc.status}`);
            throw error;
        });
        const elapsed = Math.round(performance.now() - launched);
        t.ok(elapsed <= 3000, `the restored page reports within 3 s (${elapsed} ms)`);
        t.ok((await t.state()).boards.includes('StudioBoard'), 'the restored tab shows its board');
        t.note(`perf.look ${page.perf!.look} ms, reported ${elapsed} ms after launch`);
    } finally {
        if (file) await t.cmd('close', { file }).catch(() => {});
        await t.cmd('qa.cloud', { clouds: [] }).catch(() => {});
        await host?.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

sc('cloud-files', 'Cloud tab name survives a background open and relaunch', { covers: ['cloud-files:open'] }, async (t: NT) => {
    const host = await post(t.app.base, '/api/cloud/host/start', { name: 'Studio', label: 'Owner' });
    t.eq(host.status, 200, 'Cloud starts');
    const cloud = host.j.url;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-native-tab-name-'));
    let file: string | undefined;
    let peer: Scratch | undefined;
    try {
        const made = await post(t.app.base, '/api/cloud/files/create', { cloud, name: 'Marketing site' });
        t.eq(made.status, 201, 'Cloud file created');
        file = made.j.file;
        await t.cmd('open', { file, focus: false });
        t.eq((await t.state()).file, t.file, 'quiet open keeps the local tab active');
        await t.mark({ id: 'file-tab', label: 'Marketing site', exact: true });

        await t.cmd('qa.cloud', { clouds: [{ url: cloud, name: 'Studio' }], commentName: 'Owner' });
        await t.click(center(await t.mark({ id: 'home-tab' })));
        await t.click(center(await t.mark({ id: 'home-row', label: 'Studio', exact: true })));
        const card = await t.mark({ id: 'cloud-file', label: 'Marketing site', exact: true });
        await t.click(center(card), { right: true });
        await t.waitState(s => s.menu?.items.includes('Rename'), 'Cloud card Rename action');
        await t.pickMenu('Rename');
        await t.waitState(s => !!s.modal, 'file rename dialog');
        await t.type('Campaign site', { window: 'modal' });
        const rename = (await t.views('modal')).find(v => v.kind === 'button' && v.title === 'Rename');
        t.ok(rename, 'rename button');
        await t.click(center(rename!), { window: 'modal' });
        const campaignTab = await t.mark({ id: 'file-tab', label: 'Campaign site', exact: true });
        await t.click(center(campaignTab), { right: true });
        await t.waitState(s => s.menu?.items.includes('Copy Link'), 'Cloud tab Copy Link action');
        await t.pickMenu('Copy Link');
        const copied = new URL((await t.cmd('qa.pasteboard')).text);
        t.eq(copied.searchParams.get('cloudFile'), made.j.id, 'Copy Link points to the Cloud file');
        t.eq(copied.searchParams.has('file'), false, 'Copy Link leaves out the cache path');
        await t.app.openShown(t.file);
        await t.waitState(s => s.file === t.file && !s.homeShown, 'the local tab is active before the remote rename');

        peer = await startServer(dir, {
            HOME: dir, CANVAS_STATE_DIR: path.join(dir, 'state'), CANVAS_CLOUD_SECRETS_FILE: path.join(dir, 'secrets.json'),
            CANVAS_TUNNEL_BIN: path.join(ROOT, 'test/fixtures/fake-tunnel.sh'),
            CANVAS_FAKE_TUNNEL_DIR: path.join(t.app.dir, 'tunnels'), CANVAS_FAKE_TUNNEL_NODE: process.execPath, CANVAS_FAKE_TUNNEL_ANY_PORT: '1',
        });
        const invite = await post(t.app.base, '/api/cloud/host/invite', { hostId: host.j.hostId, label: 'Editor', role: 'editor' });
        t.eq((await post(peer.base, '/api/cloud/join', { link: invite.j.link, device: 'Test Mac' })).status, 200, 'editor joins');
        const opened = await post(peer.base, '/api/cloud/files/open', { cloud, id: made.j.id });
        t.eq(opened.status, 200, 'editor opens the file');
        const renamed = await post(peer.base, '/api/canvas/rename', { file: opened.j.file, name: 'Launch site' });
        t.eq(renamed.status, 200, 'editor renames the file');
        await t.mark({ id: 'file-tab', label: 'Launch site', exact: true }, 10_000);
        t.eq((await t.state()).file, t.file, 'remote rename keeps the tab in the background');
        await t.app.openShown(file!);
        await t.waitState(s => s.windows.some((w: any) => w.main && w.title === 'Launch site'), 'the window title follows the Cloud name');
        await t.click(center(await t.mark({ id: 'home-tab' })));
        await t.click(center(await t.mark({ id: 'home-row', label: 'Recents', exact: true })));
        await t.mark({ id: 'home-card', label: 'Launch site', exact: true });
        await t.app.openShown(t.file);

        await post(t.app.base, '/api/cloud/host/stop', { hostId: host.j.hostId });
        await t.app.relaunch();
        await t.mark({ id: 'file-tab', label: 'Launch site', exact: true }, 10_000);
        const tabs = await t.cmd('tabs');
        t.eq(tabs.tabs.find((tab: any) => tab.file === file)?.name, 'Launch site', 'offline restore keeps the last known name');
        await t.shot(path.join(ROOT, 'qa/out/native/cloud-tab-name-restored.png'));
    } finally {
        if (file) await t.cmd('close', { file }).catch(() => {});
        await peer?.stop();
        await t.cmd('qa.cloud', { clouds: [] }).catch(() => {});
        await post(t.app.base, '/api/cloud/host/stop', { hostId: host.j.hostId });
        await post(t.app.base, '/api/cloud/host/wipe', { hostId: host.j.hostId });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

sc('cloud-files', 'Only actionable warnings appear on files; storage and people live in host settings', { covers: ['cloud-files:usage'] }, async (t: NT) => {
    await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
    const h = await post(t.app.base, '/api/cloud/host/start', { name: 'Studio', label: 'Anna' });
    const base = { storageBytes: 1024, freeDisk: 40*1024**3, peopleConnected: 2, uptimeMs: 7200000, messages24h: 123, restartsHour: 0, brake: 'none' };
    try {
        await t.cmd('qa.cloud', { clouds: [{ url: h.j.url, name: 'Studio' }], usage: base });
        await t.key('0', ['cmd', 'shift']);
        await t.waitState(s => s.homeShown, 'Home');
        await t.click(center(await t.mark({ id: 'home-row', label: 'Studio' })));
        await t.mark({ id: 'cloud-files-empty', label: 'No files in Studio yet' }, 7000);
        t.eq((await t.marks({ id: 'cloud-files-warning' })).length, 0, 'healthy Cloud has no banner');
        t.eq((await t.marks({ id: 'cloud-files-usage' })).length, 0, 'no diagnostics on files');
        await t.mark({ id: 'cloud-files-move' });
        await t.shot(path.join(ROOT, 'qa/out/native/cloud-files-empty.png'));
        for (const [usage, label] of [
            [{ ...base, restartsHour: 4 }, 'This Cloud keeps restarting. Check the Mac that hosts it.'],
            [{ ...base, freeDisk: 4*1024**3, brake: 'storage' }, 'This Mac is almost full. New uploads are paused.'],
        ] as const) {
            await t.cmd('qa.cloud', { usage });
            await t.mark({ id: 'cloud-files-warning', label }, 7000);
            await t.mark({ id: 'cloud-files-settings', label: 'Open Settings' });
        }
        await t.click(center(await t.mark({ id: 'cloud-files-settings' })));
        await t.mark({ id: 'cloud-host-usage', label: '2 people connected.' , window: 'settings' }, 7000);
        await t.mark({ id: 'text', label: 'Check code', window: 'settings' });
        await t.shot(path.join(ROOT, 'qa/out/native/cloud-files-host-settings.png'), 'settings');
        await t.key('w', ['cmd'], { window: 'settings' });
        await t.cmd('qa.cloud', { usage: {} });
        await t.waitFor(async () => (await t.marks({ id: 'cloud-files-warning' })).length === 0, 'unavailable usage is silent', 7000);
        await post(t.app.base, '/api/cloud/host/stop', { hostId: h.j.hostId });
        await t.mark({ id: 'cloud-files-warning', label: 'This Cloud is offline.' }, 10000);
    } finally {
        await t.key('w', ['cmd'], { window: 'settings' }).catch(() => {});
        await t.cmd('qa.cloud', { usage: null, clouds: [] });
        await post(t.app.base, '/api/cloud/host/stop', { hostId: h.j.hostId });
        await post(t.app.base, '/api/cloud/host/wipe', { hostId: h.j.hostId });
    }
});
sc('cloud-files', 'Home New File, live remote edit, offline catch-up, view mode, confinement, usage and removal', { covers: ['home:clouds', 'settings:cloud', 'cloud-files:new', 'cloud-files:open', 'cloud-files:remote', 'cloud-files:offline', 'cloud-files:confinement', 'cloud-files:usage', 'cloud-files:undo', 'cloud-files:presence'] }, async (t: NT) => {
    await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
    const host = await post(t.app.base, '/api/cloud/host/start', { name: 'Studio', label: 'Anna' });
    t.eq(host.status, 200, 'host starts');
    const cloud = host.j.url;
    let peer: Scratch | undefined;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-native-files-'));
    try {
        await t.cmd('qa.cloud', { clouds: [{ url: cloud, name: 'Studio' }], commentName: 'Anna' });
        await t.key('0', ['cmd', 'shift']);
        await t.waitState(s => s.homeShown, 'Home');
        await t.click(center(await t.mark({ id: 'home-row', label: 'Studio' }, 8000)));
        await t.mark({ id: 'cloud-files-new' }, 5000);
        await t.key('n', ['cmd']);
        await t.waitState(s => typeof s.file === 'string' && s.file.includes('/cloud-files/') && !s.homeShown, 'a Cloud file', 10000);
        const file = (await t.state()).file;
        const info = await (await fetch(t.app.base + '/api/cloud/files/info?file=' + encodeURIComponent(file))).json() as any;
        t.eq(info.role, 'owner', 'owner can edit');
        const env = { HOME: dir, CANVAS_STATE_DIR: path.join(dir, 'state'), CANVAS_CLOUD_SECRETS_FILE: path.join(dir, 'secrets.json'), CANVAS_COMMENT_NAME: 'Ben', CANVAS_TUNNEL_BIN: path.join(ROOT, 'test/fixtures/fake-tunnel.sh'), CANVAS_FAKE_TUNNEL_DIR: path.join(t.app.dir, 'tunnels'), CANVAS_FAKE_TUNNEL_NODE: process.execPath, CANVAS_FAKE_TUNNEL_ANY_PORT: '1' };
        peer = await startServer(dir, env);
        const inv = await post(t.app.base, '/api/cloud/host/invite', { hostId: host.j.hostId, label: 'Ben', role: 'editor' });
        await post(peer.base, '/api/cloud/join', { link: inv.j.link, device: 'A Mac' });
        const opened = await post(peer.base, '/api/cloud/files/open', { cloud, id: info.file });
        t.eq(opened.status, 200, 'peer opens');
        const pf = opened.j.file;
        const made = await post(peer.base, '/api/structure', { file: pf, op: 'add', nodes: [{ id: 'SharedBoard', type: 'frame', name: 'Shared board', width: 320, height: 240, children: [{id:'SharedText',type:'text',x:20,y:20,content:'Shared',fontSize:16}] }] });
        t.eq(made.status, 200, 'peer adds board');
        await t.waitFor(async () => (await t.state()).boards.includes('SharedBoard'), 'remote edit on the page within one second', 1000);
        await t.waitJs('(()=>{const h=window.canvasHost,r=h.worldRectOf("SharedBoard"),c=h.cam,i=h.insets;return r && r.x*c.z+c.x+r.w*c.z/2>i.l && r.y*c.z+c.y+r.h*c.z/2>i.t;})()', 'first remote board is visible inside the editor',1000);
        const presence = await post(peer.base, '/api/cloud/files/presence', { file: pf, p: { cursor: { x: 90, y: 60 }, sel: ['SharedBoard'], editing: { id: 'SharedBoard' } } });
        t.ok(presence.j.ok, 'peer sends presence');
        await t.waitJs('document.querySelector(".cp-cursor")?.textContent.includes("Ben") && !!document.querySelector(".cp-selection")', 'peer cursor and selection', 4000);
        await t.waitJs('document.querySelector(".cp-editing")?.textContent.includes("Ben is editing")', 'peer editing label', 4000);
        await post(peer.base, '/api/cloud/files/presence', {file:pf,p:{preview:{kind:'scrub',ids:['SharedBoard'],key:'opacity',value:0.4},editing:{id:'SharedText',text:'Live words'}}});
        await t.waitJs('window.canvasHost.live.sceneOf("SharedBoard")?.root.opacity===0.4 && JSON.stringify(window.canvasHost.live.sceneOf("SharedBoard")).includes("Live words")', 'live scrub and typing drawn', 4000);
        await t.shot(path.join(ROOT,'qa/out/native/cloud-files-presence.png'));
        await post(peer.base, '/api/cloud/files/presence', {file:pf,p:{preview:null,editing:null}});
        await t.waitJs('window.canvasHost.live.sceneOf("SharedBoard")?.root.opacity!==0.4', 'preview cleared without a write', 4000);
        await fetch(peer.base+'/api/update',{method:'POST',headers:{'x-canvas':'1','content-type':'application/json','x-canvas-source':'mcp','x-canvas-agent':'Agent'},body:JSON.stringify({file:pf,id:'SharedText',props:{content:'Agent edit'}})});
        await t.waitJs('document.querySelector(".cp-agent")?.textContent.includes("Ben")','peer agent cursor',4000);
        await post(peer.base, '/api/cloud/files/presence', { file:pf, p:{editing:null} });
        await post(t.app.base, '/api/update', { file, id:'SharedBoard', props:{opacity:0.5} });
        await t.waitFor(async()=>fs.readFileSync(path.join(pf,'document.json'),'utf8').includes('"opacity":0.5'), 'own edit confirmed');
        await t.key('z',['cmd']);
        await t.waitFor(async()=>!fs.readFileSync(path.join(pf,'document.json'),'utf8').includes('"opacity"'), 'own undo');
        await post(t.app.base, '/api/update', { file, id:'SharedBoard', props:{name:'Local title'} });
        await t.waitFor(async()=>fs.readFileSync(path.join(pf,'document.json'),'utf8').includes('Local title'), 'local title confirmed');
        await post(peer.base, '/api/update', { file:pf, id:'SharedBoard', props:{name:'Peer title'} });
        await t.waitFor(async()=>JSON.stringify(await t.js('return window.canvasHost.doc')).includes('Peer title'), 'remote title');
        await post(peer.base, '/api/update', { file:pf, id:'SharedBoard', props:{name:'Local title'} });
        await t.waitFor(async()=>JSON.stringify(await t.js('return window.canvasHost.doc')).includes('Local title'), 'remote change away and back');
        await t.key('z',['cmd']);
        await t.waitState(s=>(s.toast || '').includes('Ben changed'), 'undo refusal names the remote writer', 4000);
        await t.shot(path.join(ROOT, 'qa/out/native/cloud-files-live.png'));
        const blocked = await post(t.app.base, '/api/update', { file, id: 'SharedBoard', props: { fill: { type: 'image', url: '../outside.png' } } });
        t.ok(blocked.status >= 400, 'foreign fill refused');
        const confined = await (await fetch(t.app.base+'/api/scene?file='+encodeURIComponent(file)+'&id=SharedBoard')).json() as any;
        t.eq(confined.images.length,0,'no outside image drawn');
        await post(t.app.base, '/api/cloud/files/disconnect', { file });
        await post(peer.base, '/api/update', { file: pf, id: 'SharedBoard', props: { name: 'Reconnected' } });
        await post(t.app.base, '/api/cloud/files/reconnect', { file });
        await t.waitFor(async () => JSON.stringify(await t.js('return window.canvasHost.doc')).includes('Reconnected'), 'offline catch-up', 8000);
        await t.key('0', ['cmd', 'shift']);
        await t.click(center(await t.mark({ id: 'home-row', label: 'Studio' }, 5000)));
        await t.mark({ id: 'cloud-files-search' }, 5000);
        await t.shot(path.join(ROOT, 'qa/out/native/cloud-files-home.png'));
        await t.click(center(await t.mark({ id: 'cloud-file', label: 'Untitled' }, 5000)));
        await t.waitState(s => !s.homeShown, 'open from Home');
        const demote = await post(t.app.base, '/api/cloud/host/invite', { hostId: host.j.hostId, label: 'Ben', role: 'viewer' });
        t.eq(demote.status, 200, 'viewer mid-edit');
        await t.waitFor(async () => (await (await fetch(peer!.base + '/api/cloud/files/info?file=' + encodeURIComponent(pf))).json() as any).role === 'viewer', 'viewer applies', 5000);
        t.eq((await post(peer.base, '/api/update', { file: pf, id: 'SharedBoard', props: { name: 'Denied' } })).status, 403, 'viewer route gate');
        const status = await (await fetch(t.app.base + '/api/cloud/host?hostId=' + host.j.hostId)).json() as any;
        await post(t.app.base, '/api/cloud/host/remove', { hostId: host.j.hostId, personId: status.people.find((p: any) => p.label === 'Ben').id });
        await t.waitFor(async () => !fs.existsSync(pf), 'removed peer cache gone', 5000);
    }
    finally {
        await peer?.stop();
        await post(t.app.base, '/api/cloud/host/stop', { hostId: host.j.hostId });
        await post(t.app.base, '/api/cloud/host/wipe', { hostId: host.j.hostId });
        await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
sc('cloud-files', 'Viewer opens from Home with disabled editing, then offline membership removal closes the file', { covers: ['home:clouds', 'settings:cloud', 'cloud-files:viewer', 'cloud-files:removed'] }, async (t: NT) => {
    await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-native-viewer-'));
    let host: Scratch | undefined;
    try {
        host = await startServer(dir, { HOME: dir, CANVAS_STATE_DIR: path.join(dir, 'state'), CANVAS_CLOUD_SECRETS_FILE: path.join(dir, 'secrets.json'), CANVAS_COMMENT_NAME: 'Ben', CANVAS_TUNNEL_BIN: path.join(ROOT, 'test/fixtures/fake-tunnel.sh'), CANVAS_FAKE_TUNNEL_DIR: path.join(t.app.dir, 'tunnels'), CANVAS_FAKE_TUNNEL_NODE: process.execPath, CANVAS_FAKE_TUNNEL_ANY_PORT: '1' });
        const started = await post(host.base, '/api/cloud/host/start', { name: 'Studio', label: 'Ben' }), cloud = started.j.url;
        const inv = await post(host.base, '/api/cloud/host/invite', { hostId: started.j.hostId, label: 'Anna', role: 'viewer' });
        const joined = await post(t.app.base, '/api/cloud/join', { link: inv.j.link, device: 'A Mac' });
        t.eq(joined.status, 200, 'viewer joins');
        await t.cmd('qa.cloud', { clouds: [{ url: cloud, name: 'Studio' }], commentName: 'Anna' });
        await t.key('0', ['cmd', 'shift']);
        await t.waitState(s => s.homeShown, 'Home');
        await t.click(center(await t.mark({ id: 'home-row', label: 'Studio' }, 6000)));
        await t.mark({ id: 'cloud-files-empty', label: 'No files yet' }, 6000);
        await t.mark({ id: 'text', label: 'Files show up here when an editor adds them.' });
        t.eq((await t.marks({ id: 'cloud-files-new' })).length + (await t.marks({ id: 'cloud-files-move' })).length, 0, 'viewer has no creation actions');
        await t.key('n', ['cmd']);
        t.eq((await t.state()).panels.length, 0, 'viewer Command N opens no local save panel');
        await t.shot(path.join(ROOT, 'qa/out/native/cloud-files-viewer-empty.png'));
        const made = await post(host.base, '/api/cloud/files/create', { cloud, name: 'Design' });
        t.eq(made.status, 201, 'host creates');
        await post(host.base,'/api/structure',{file:made.j.file,op:'add',nodes:[{id:'ViewerBoard',type:'frame',width:300,height:200,children:[{id:'ViewerText',type:'text',x:20,y:20,content:'Read only',fontSize:16}]}]});
        await t.waitFor(async()=>((await (await fetch(host!.base+'/api/cloud/files/info?file='+encodeURIComponent(made.j.file))).json()) as any).pending===0,'viewer fixture confirmed');
        await t.click(center(await t.mark({ id: 'cloud-file', label: 'Design' }, 6000)));
        await t.waitState(s => s.cloudReadOnly === true && typeof s.file === 'string' && s.file.includes('/cloud-files/'), 'viewer view mode', 10000);
        const file = (await t.state()).file;
        t.eq((await post(t.app.base, '/api/update', { file, id: 'Missing', props: { x: 1 } })).status, 403, 'viewer dispatch gate');
        t.eq((await t.cmd('qa.mainmenu',{title:'Paste'})).enabled,false,'viewer Paste is disabled');
        await t.waitJs('!!window.canvasHost.worldRectOf("ViewerText")','viewer text drawn');
        await t.settle();
        const textPoint=center(await t.rect('ViewerText'));
        await t.doubleClick(textPoint);
        await new Promise(r=>setTimeout(r,200));
        const textEditing=(await t.state()).textEditing;
        if(textEditing)await t.key('Escape');
        const board=await t.rect('ViewerBoard'), from={x:board.x+board.w-35,y:board.y+board.h-35};
        await t.drag(from,{x:from.x+45,y:from.y+30});
        await t.click(center(await t.mark({id:'page-add'})));
        await new Promise(r=>setTimeout(r,300));
        t.ok(!textEditing,'viewer cannot enter text editing');
        t.ok(!/read only|Could not (?:change the pages|move)/i.test((await t.state()).toast ?? ''),'viewer drag and Add page controls stay inactive');
        await t.shot(path.join(ROOT, 'qa/out/native/cloud-files-viewer.png'));
        t.eq((await post(t.app.base, '/api/cloud/files/disconnect', { file })).status, 200, 'viewer goes offline');
        const st = await (await fetch(host.base + '/api/cloud/host?hostId=' + started.j.hostId)).json() as any;
        t.eq((await post(host.base, '/api/cloud/host/remove', { hostId: started.j.hostId, personId: st.people.find((p: any) => p.label === 'Anna').id })).status, 200, 'owner removes viewer');
        t.ok(fs.existsSync(file), 'offline viewer still has the cache');
        // Let the stale device reach the adapter through the fake tunnel so its HTTP refusal arrives.
        const secrets = JSON.parse(fs.readFileSync(path.join(t.app.dir, 'cloud-secrets.json'), 'utf8'));
        const { addr } = JSON.parse(secrets[`hosted:${started.j.hostId}`]);
        const tunnel = path.join(t.app.dir, 'tunnels', `${addr}.json`);
        const route = JSON.parse(fs.readFileSync(tunnel, 'utf8'));
        fs.writeFileSync(tunnel, JSON.stringify({ ...route, allow: null }));
        t.eq((await post(t.app.base, '/api/cloud/files/reconnect', { file })).status, 200, 'viewer reconnects');
        await t.waitState(s => s.file !== file, 'removed file closes', 8000);
        t.ok(!fs.existsSync(file), 'removed cache deleted');
    }
    finally {
        await host?.stop();
        await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

sc('cloud-files', 'Empty actions, page drop confirmation, matching cards and search in light and dark', { covers: ['cloud-files:new', 'cloud-files:open', 'home:clouds'] }, async (t: NT) => {
    await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
    const h = await post(t.app.base, '/api/cloud/host/start', { name: 'Studio', label: 'Anna' });
    const local = path.join(t.app.docs, 'Design.canvas');
    fs.cpSync(PLAYGROUND, local, { recursive: true });
    const { document } = expectedMove(local);
    try {
        await t.cmd('qa.cloud', { clouds: [{ url: h.j.url, name: 'Studio' }] });
        await t.key('0', ['cmd', 'shift']);
        await t.click(center(await t.mark({ id: 'home-row', label: 'Studio' }, 6000)));
        await t.mark({ id: 'cloud-files-empty', label: 'No files in Studio yet' }, 6000);
        t.eq((await t.marks({ id: 'cloud-files-search' })).length, 0, 'no search before files');
        await t.click(center(await t.mark({ id: 'cloud-files-move' })));
        t.ok((await t.state()).panels.includes('Move a file here'), 'secondary action opens the local file picker');
        const target = center(await t.mark({ id: 'cloud-files-empty' }));
        const drag = () => t.cmd('qa.files', { files: [local], from: [target.x - 120, target.y], to: [target.x, target.y] });
        await drag();
        await t.waitState(s => !!s.modal, 'move confirmation', 5000);
        let button = (await t.views('modal')).find(v => v.kind === 'button' && v.title === 'Cancel');
        t.ok(button, 'Cancel button');
        await t.click(center(button), { window: 'modal' });
        t.ok(fs.existsSync(local), 'cancel keeps the source');
        await drag();
        await t.waitState(s => !!s.modal, 'move confirmation again', 5000);
        button = (await t.views('modal')).find(v => v.kind === 'button' && v.title === 'Move');
        t.ok(button, 'Move button');
        await t.click(center(button), { window: 'modal' });
        await t.waitState(s => !s.homeShown && typeof s.file === 'string' && s.file.includes('/cloud-files/'), 'dropped file opens in this Cloud', 15000);
        t.ok(!fs.existsSync(local), 'verified source moved to Trash');
        const moved = (await t.state()).file!;
        t.eq(fs.readFileSync(path.join(moved, 'document.json'), 'utf8'), document, 'playground document keeps every byte after JSON serialization');
        const listed = await (await fetch(t.app.base + '/api/cloud/files?cloud=' + encodeURIComponent(h.j.url))).json() as any;
        t.eq(listed.files.length, 1, 'one published file');
        const name = listed.files[0].name;
        await t.key('0', ['cmd', 'shift']);
        await t.mark({ id: 'cloud-file', label: name }, 7000);
        await t.mark({ id: 'text', label: 'Edited just now' });
        const search = await t.mark({ id: 'cloud-files-search' });
        const create = await t.mark({ id: 'cloud-files-new' });
        t.near(search.h, create.h, 1, 'header controls share a height');
        for (const theme of ['light', 'dark']) {
            await t.cmd('qa.theme', { theme });
            await t.shot(path.join(ROOT, 'qa/out/native/cloud-files-grid-' + theme + '.png'));
        }
        await t.click(center(search));
        await t.type('No match');
        await t.mark({ id: 'text', label: 'No files match your search' }, 5000);
        t.eq((await t.marks({ id: 'cloud-file' })).length, 0, 'nonmatching cards hidden');
        await t.key('a', ['cmd']); await t.key('Delete');
        await t.mark({ id: 'cloud-file', label: name }, 5000);
        await t.click(center(await t.mark({ id: 'cloud-files-new' })));
        await t.waitState(s => !s.homeShown && typeof s.file === 'string' && s.file.includes('/cloud-files/'), 'header creates here', 10000);
    } finally {
        await t.cmd('qa.theme', { theme: 'light' });
        await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
        await post(t.app.base, '/api/cloud/host/stop', { hostId: h.j.hostId });
        await post(t.app.base, '/api/cloud/host/wipe', { hostId: h.j.hostId });
        fs.rmSync(local, { recursive: true, force: true });
    }
});

sc('cloud-files', 'Live people strip shows roles and follows a cursor', { covers: ['cloud-files:presence'] }, async (t: NT) => {
  await t.cmd('qa.cloud', { commentName:'Anna' }); await t.settle();
  await t.waitState(s => !s.toast, 'prior toast cleared', 12000);
  await t.js(`const h=window.canvasHost; window.canvasCloudFile={status:'connected',role:'editor',author:{name:'Anna'}}; h.presence.receive([{session:'peer-ben',by:{name:'Ben'},role:'editor',page:h.page,cursor:{x:900,y:500}}]); h.emit('presencechange');`);
  const anna = await t.mark({ id:'live-person-self', label:'Anna, editor' }, 4000);
  const ben = await t.mark({ id:'live-person-peer-ben', label:'Ben, editor' }, 4000);
  t.ok(anna.x < ben.x, 'you first');
  const before = await t.js<any>('return {...window.canvasHost.cam}');
  await t.click(center(ben)); await t.settle();
  t.ok(JSON.stringify(await t.js('return {...window.canvasHost.cam}')) !== JSON.stringify(before), 'click follows cursor');
  if (process.env.CANVAS_UI_SHOTS) { fs.mkdirSync(process.env.CANVAS_UI_SHOTS, { recursive:true }); await t.shot(path.join(process.env.CANVAS_UI_SHOTS,'native-people-after.png')); }
});
