// Two isolated Canvas servers, one Mac host, through the fake tunnel. No production state or credentials.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, sleep, ROOT, type Scratch } from './lib.ts';
import { measurePresence } from './cloud-files-presence.ts';
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-files-e2e-')));
const servers: Scratch[] = [];
const until = async (what: string, fn: () => Promise<boolean>, ms = 10000) => { const end = Date.now() + ms; while (!(await fn())) {
    if (Date.now() > end)
        throw new Error('Timed out: ' + what);
    await sleep(40);
} };
const call = async (s: Scratch, p: string, body?: unknown) => { const r = await fetch(s.base + p, { method: body === undefined ? 'GET' : 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); const j = await r.json() as any; assert.ok(r.ok, `${p}: ${r.status} ${JSON.stringify(j)}`); return j; };
try {
    const env = { CANVAS_TUNNEL_BIN: path.join(ROOT, 'test/fixtures/fake-tunnel.sh'), CANVAS_FAKE_TUNNEL_DIR: path.join(tmp, 'tunnels'), CANVAS_FAKE_TUNNEL_NODE: process.execPath, CANVAS_FAKE_TUNNEL_ANY_PORT: '1', CANVAS_COMMENT_NAME: 'Anna' };
    fs.mkdirSync(env.CANVAS_FAKE_TUNNEL_DIR);
    for (const name of ['anna', 'ben']) {
        const dir = path.join(tmp, name);
        fs.mkdirSync(dir);
        const home = path.join(tmp, name + '-home');
        fs.symlinkSync(dir, home);
        servers.push(await startServer(dir, { ...env, HOME: home, CANVAS_STATE_DIR: path.join(dir, 'state'), CANVAS_CLOUD_SECRETS_FILE: path.join(dir, 'secrets.json'), CANVAS_COMMENT_NAME: name === 'anna' ? 'Anna' : 'Ben' }));
    }
    const a = servers[0];
    let b = servers[1];
    const host = await call(a, '/api/cloud/host/start', { name: 'Studio', label: 'Anna' });
    const inv = await call(a, '/api/cloud/host/invite', { hostId: host.hostId, label: 'Ben', role: 'editor' });
    const joined = await call(b, '/api/cloud/join', { link: inv.link, device: 'A Mac' });
    const cloud = host.url;
    const created = await call(a, '/api/cloud/files/create', { cloud, name: 'Design' });
    const fileId = created.id;
    const opened = await call(b, '/api/cloud/files/open', { cloud: joined.url, id: fileId });
    const fa = created.file, fb = opened.file;
    const update = (s: Scratch, file: string, props: unknown) => call(s, '/api/update?file=' + encodeURIComponent(file), { file, id: 'Board', props });
    await call(a, '/api/structure?file=' + encodeURIComponent(fa), { file: fa, op: 'add', nodes: [{ type: 'frame', id: 'Board', name: 'Board', width: 300, height: 200, children: [{ id: 'Title', type: 'text', content: 'Hello' }] }] });
    await until('remote board', async () => fs.readFileSync(path.join(fb, 'document.json'), 'utf8').includes('Title'));
    await Promise.all([update(a, fa, { x: 12 }), update(b, fb, { y: 24 })]);
    const bytes = (file: string) => fs.readFileSync(path.join(file, 'document.json'), 'utf8');
    await until('identical documents', async () => bytes(fa) === bytes(fb) && bytes(fa).includes('\"x\":12') && bytes(fa).includes('\"y\":24')).catch(async (e) => { console.error(JSON.stringify(await call(a, '/api/cloud/files/info?file=' + encodeURIComponent(fa)))); console.error(JSON.stringify(await call(b, '/api/cloud/files/info?file=' + encodeURIComponent(fb)))); throw e; });
    assert.match(bytes(fa), /"x":12/);
    assert.match(bytes(fa), /"y":24/);
    console.log('PASS create, open, concurrent edits and byte identical documents');
    await update(a, fa, { opacity: 0.5 });
    await until('own edit', async () => bytes(fa) === bytes(fb) && bytes(fa).includes('opacity'));
    await call(a, '/api/history/undo?file=' + encodeURIComponent(fa), {});
    await until('own undo', async () => bytes(fa) === bytes(fb) && !bytes(fa).includes('opacity'));
    console.log('PASS undo of own edit');
    const failedMove=path.join(tmp,'anna','Failed.canvas');
    fs.mkdirSync(path.join(failedMove,'media'),{recursive:true});
    const localBefore=JSON.stringify({version:'2.21',children:[]});
    fs.writeFileSync(path.join(failedMove,'document.json'),localBefore);
    fs.writeFileSync(path.join(failedMove,'media','invalid.png'),'not an image');
    const hostRooms=()=>fs.readdirSync(path.join(tmp,'anna','state'),{recursive:true}).map(String).filter(p=>/\/files\/[0-9a-f-]{36}\.sqlite$/.test(p)).sort();
    const roomsBefore=hostRooms();
    const failed=await fetch(a.base+'/api/cloud/files/move?file='+encodeURIComponent(failedMove),{method:'POST',headers:{'x-canvas':'1','content-type':'application/json'},body:JSON.stringify({cloud})});
    assert.ok(failed.status>=400,'invalid media refuses the move');
    const failure=await failed.json();
    assert.equal(fs.readFileSync(path.join(failedMove,'document.json'),'utf8'),localBefore);
    assert.deepEqual(hostRooms(),roomsBefore,'failed import leaves no orphan room: '+JSON.stringify(failure));
    console.log('PASS failed move keeps local source and cleans its Cloud import');
    await measurePresence(a,b,fa,fb);
    // A package carrying all three media types is moved only after its published hashes check out.
    const pkg = path.join(tmp, 'anna', 'Move.canvas');
    fs.mkdirSync(pkg);
    fs.mkdirSync(path.join(pkg, 'media'));
    fs.mkdirSync(path.join(pkg, 'shaders'));
    fs.writeFileSync(path.join(pkg, 'media', 'image.png'), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    fs.writeFileSync(path.join(pkg, 'media', 'clip.mp4'), Buffer.from([0, 0, 0, 20, ...Buffer.from('ftypisom'), 0, 0, 0, 0]));
    fs.writeFileSync(path.join(pkg, 'shaders', 'Shader.src-123456789abc.wgsl'), 'fn shade() {}');
    fs.writeFileSync(path.join(pkg, 'document.json'), JSON.stringify({ version: '2.21', children: [{ type: 'frame', id: 'Media', width: 100, height: 100, fill: { type: 'image', url: 'media/image.png' }, children: Array.from({ length: 130 }, (_, i) => ({ id: 'Item' + i, type: 'rectangle', width: 1, height: 1 })) }] }));
    fs.writeFileSync(path.join(pkg, 'widgets.json'), JSON.stringify({ version: 1, widgets: [{ id: 'Video', kind: 'video', name: 'Clip', x: 0, y: 0, w: 100, h: 100, locked: false, config: { src: 'media/clip.mp4' } }, { id: 'Shader', kind: 'shader', name: 'Shader', x: 120, y: 0, w: 100, h: 100, locked: false, config: { rev: '123456789abc' } }] }));
    const moved = await call(a, '/api/cloud/files/move?file=' + encodeURIComponent(pkg), { cloud, name: 'Media' });
    assert.equal(fs.existsSync(pkg), false);
    assert.ok(moved.verified);
    const movedB = await call(b, '/api/cloud/files/open', { cloud: joined.url, id: moved.id });
    await until('moved document identical', async () => bytes(moved.file) === bytes(movedB.file));
    for (const rel of ['media/image.png', 'media/clip.mp4', 'shaders/Shader.src-123456789abc.wgsl'])
        assert.deepEqual(fs.readFileSync(path.join(moved.file, rel)), fs.readFileSync(path.join(movedB.file, rel)));
    console.log('PASS verified move with image, video and shader');
    await call(a, '/api/cloud/files/disconnect', { file: fa });
    await update(a, fa, { x: 33 });
    await update(b, fb, { y: 44 });
    await call(a, '/api/cloud/files/reconnect', { file: fa });
    await until('offline catch-up', async () => bytes(fa) === bytes(fb));
    console.log('PASS offline edits and reconnect');
    // A closed client restarts from its saved seq, then catches the edits it missed.
    await call(b,'/api/cloud/files/close',{file:fb});
    await b.stop();
    await update(a, fa, { name: 'While closed' });
    const dirB = path.join(tmp, 'ben');
    b = await startServer(dirB, { ...env, HOME: dirB, CANVAS_STATE_DIR: path.join(dirB, 'state'), CANVAS_CLOUD_SECRETS_FILE: path.join(dirB, 'secrets.json'), CANVAS_COMMENT_NAME: 'Ben', CANVAS_CLOUD_URL: cloud });
    servers[1] = b;
    await call(b, '/api/cloud/files/open', { cloud, id: fileId });
    await until('restart catch-up', async () => bytes(fa) === bytes(fb) && bytes(fb).includes('While closed'));
    console.log('PASS restart catch-up');
    const comment = { opId: crypto.randomUUID(), doc: '00000000-0000-4000-8000-000000000000', at: new Date().toISOString(), op: { kind: 'thread.create', thread: crypto.randomUUID(), comment: crypto.randomUUID(), anchor: { nodeId: 'Title', board: 'Board', x: 0.5, y: 0.5, preview: { name: 'Title', type: 'text' } }, body: 'Shared note' } };
    await call(b, '/api/comments/ops?file=' + encodeURIComponent(fb), { ops: [comment] });
    await until('room comment', async () => JSON.stringify(await call(a, '/api/comments?file=' + encodeURIComponent(fa))).includes('Shared note'));
    await until('comment bytes', async () => { const ca = JSON.parse(fs.readFileSync(path.join(fa, 'comments.json'), 'utf8')), cb = JSON.parse(fs.readFileSync(path.join(fb, 'comments.json'), 'utf8')); return ca.seq === cb.seq && JSON.stringify(ca.threads) === JSON.stringify(cb.threads); });
    assert.equal(JSON.parse(fs.readFileSync(path.join(fa,'comments.json'),'utf8')).format,1);
    console.log('PASS comments in the file room');
    // Existing invitation management changes the same person's role synchronously on the host.
    await call(a, '/api/cloud/host/invite', { hostId: host.hostId, label: 'Ben', role: 'viewer' });
    await until('viewer role', async () => (await call(b, '/api/cloud/files/info?file=' + encodeURIComponent(fb))).role === 'viewer');
    const denied = await fetch(b.base + '/api/update?file=' + encodeURIComponent(fb), { method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: JSON.stringify({ file: fb, id: 'Title', props: { x: 99 } }) });
    assert.equal(denied.status, 403);
    for (const route of ['/api/structure', '/api/move', '/api/resize', '/api/scale', '/api/text', '/api/replace', '/api/layout', '/api/overrides', '/api/pages', '/api/widgets', '/api/shaders', '/api/videos', '/api/images', '/api/history/undo', '/api/variations', '/api/agent/run']) {
        const r = await fetch(b.base + route + '?file=' + encodeURIComponent(fb), { method: 'POST', headers: { 'x-canvas': '1', 'content-type': 'application/json' }, body: JSON.stringify({ file: fb }) });
        assert.equal(r.status, 403, route);
    }
    console.log('PASS viewer mid-edit and every mutation family');
    // Cache deletion follows the authenticated revocation frame. A disconnected Mac cannot distinguish a
    // revoked tunnel key from an outage; offline catch-up is exercised separately above.
    const status = await call(a, '/api/cloud/host?hostId=' + host.hostId);
    const person = status.people.find((p: any) => p.label === 'Ben');
    await call(a, '/api/cloud/host/remove', { hostId: host.hostId, personId: person.id });
    await until('removed cache', async () => !fs.existsSync(fb));
    console.log('PASS removed member cache deletion');
}
catch (e) {
    console.error('FAIL', (e as Error).message);
    for (const s of servers)
        console.error(s.log.join('').slice(-2000));
    process.exitCode = 1;
}
finally {
    for (const s of servers)
        await s.stop().catch(() => { });
    fs.rmSync(tmp, { recursive: true, force: true });
}
