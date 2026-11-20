// Cloud files: real Home and editor, second Canvas driven over HTTP through the fake tunnel.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { center, NT, sc } from './harness.ts';
import { startServer, ROOT, type Scratch } from '../lib.ts';
const post = async (base: string, p: string, b: unknown) => { const r = await fetch(base + p, { method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: JSON.stringify(b) }); return { status: r.status, j: await r.json() as any }; };
sc('cloud-files', 'Home New File, live remote edit, offline catch-up, view mode, confinement, usage and removal', { covers: ['home:clouds', 'settings:cloud', 'cloud-files:new', 'cloud-files:open', 'cloud-files:remote', 'cloud-files:offline', 'cloud-files:confinement', 'cloud-files:usage'] }, async (t: NT) => {
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
        await t.click(center(await t.mark({ id: 'cloud-files-new' }, 5000)));
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
        const made = await post(peer.base, '/api/structure', { file: pf, op: 'add', nodes: [{ id: 'SharedBoard', type: 'frame', name: 'Shared board', width: 320, height: 240, children: [] }] });
        t.eq(made.status, 200, 'peer adds board');
        await t.waitFor(async () => (await t.state()).boards.includes('SharedBoard'), 'remote edit on the page within one second', 1000);
        await t.shot(path.join(ROOT, 'qa/out/native/cloud-files-live.png'));
        const blocked = await post(t.app.base, '/api/update', { file, id: 'SharedBoard', props: { fill: { type: 'image', url: '../outside.png' } } });
        t.ok(blocked.status >= 400, 'foreign fill refused');
        await post(t.app.base, '/api/cloud/files/disconnect', { file });
        await post(peer.base, '/api/update', { file: pf, id: 'SharedBoard', props: { name: 'Reconnected' } });
        await post(t.app.base, '/api/cloud/files/reconnect', { file });
        await t.waitFor(async () => JSON.stringify(await t.js('return docMsg()')).includes('Reconnected'), 'offline catch-up', 8000);
        await t.key('0', ['cmd', 'shift']);
        await t.click(center(await t.mark({ id: 'home-row', label: 'Studio' }, 5000)));
        await t.mark({ id: 'cloud-files-usage' }, 5000);
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
        await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
sc('cloud-files', 'Viewer opens from Home with disabled editing, then removal closes the file', { covers: ['home:clouds', 'settings:cloud', 'cloud-files:viewer', 'cloud-files:removed'] }, async (t: NT) => {
    await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-native-viewer-'));
    let host: Scratch | undefined;
    try {
        host = await startServer(dir, { HOME: dir, CANVAS_STATE_DIR: path.join(dir, 'state'), CANVAS_CLOUD_SECRETS_FILE: path.join(dir, 'secrets.json'), CANVAS_COMMENT_NAME: 'Ben', CANVAS_TUNNEL_BIN: path.join(ROOT, 'test/fixtures/fake-tunnel.sh'), CANVAS_FAKE_TUNNEL_DIR: path.join(t.app.dir, 'tunnels'), CANVAS_FAKE_TUNNEL_NODE: process.execPath, CANVAS_FAKE_TUNNEL_ANY_PORT: '1' });
        const started = await post(host.base, '/api/cloud/host/start', { name: 'Studio', label: 'Ben' }), cloud = started.j.url;
        const made = await post(host.base, '/api/cloud/files/create', { cloud, name: 'Design' });
        t.eq(made.status, 201, 'host creates');
        const inv = await post(host.base, '/api/cloud/host/invite', { hostId: started.j.hostId, label: 'Anna', role: 'viewer' });
        const joined = await post(t.app.base, '/api/cloud/join', { link: inv.j.link, device: 'A Mac' });
        t.eq(joined.status, 200, 'viewer joins');
        await t.cmd('qa.cloud', { clouds: [{ url: cloud, name: 'Studio' }], commentName: 'Anna' });
        await t.key('0', ['cmd', 'shift']);
        await t.waitState(s => s.homeShown, 'Home');
        await t.click(center(await t.mark({ id: 'home-row', label: 'Studio' }, 6000)));
        await t.click(center(await t.mark({ id: 'cloud-file', label: 'Design' }, 6000)));
        await t.waitState(s => s.cloudReadOnly === true && typeof s.file === 'string' && s.file.includes('/cloud-files/'), 'viewer view mode', 10000);
        const file = (await t.state()).file;
        t.eq((await post(t.app.base, '/api/update', { file, id: 'Missing', props: { x: 1 } })).status, 403, 'viewer dispatch gate');
        await t.shot(path.join(ROOT, 'qa/out/native/cloud-files-viewer.png'));
        const st = await (await fetch(host.base + '/api/cloud/host?hostId=' + started.j.hostId)).json() as any;
        await post(host.base, '/api/cloud/host/remove', { hostId: started.j.hostId, personId: st.people.find((p: any) => p.label === 'Anna').id });
        await t.waitState(s => s.file !== file, 'removed file closes', 8000);
        t.ok(!fs.existsSync(file), 'removed cache deleted');
    }
    finally {
        await host?.stop();
        await t.cmd('qa.cloud', { clouds: [], commentName: 'Anna' });
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
