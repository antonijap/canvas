import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CloudHost, newSecret } from '../cloud/adapters/mac/host.ts';
import { FileStateStore } from '../src/cloud-files-store.ts';
import { stateFromFiles, materialize } from '../cloud/core/files/state.ts';
import { MemoryObjects } from '../cloud/core/files/objects.ts';
import { MUTATING_ROUTES, readOnlyRoute } from '../src/cloud-files-gate.ts';
const doc = { version: '2.21', children: [{ id: 'Board', type: 'frame', width: 300, height: 200, children: [{ id: 'Title', type: 'text', content: 'Hello' }] }] };
const author = { id: 'anna', name: 'Anna' };
test('cancelled imports release room, objects and reservations', async () => {
    const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-import-cancel-')), h=new CloudHost({dir,port:0});
    try {
        const token=h.ownerDevice('Anna'),base='http://127.0.0.1:'+await h.start(),id=crypto.randomUUID();
        const call=async(p:string,method:string,body?:unknown)=>fetch(base+p,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
        assert.equal((await call('/v1/files','POST',{id,name:'Import',importing:true})).status,201);
        await call(`/v1/files/${id}/manifest`,'GET');
        assert.equal((await call(`/v1/files/${id}/uploads`,'POST',{sha256:'a'.repeat(64),bytes:100,type:'image/png'})).status,201);
        assert.ok(fs.existsSync(path.join(dir,'files',id+'.sqlite')));
        assert.equal((await call(`/v1/files/${id}/import`,'DELETE')).status,200);
        assert.equal((await call(`/v1/files/${id}/manifest`,'GET')).status,404);
        assert.equal(fs.existsSync(path.join(dir,'files',id+'.sqlite')),false);
        assert.equal(fs.existsSync(path.join(dir,'objects','files',id)),false);
        const db=new DatabaseSync(path.join(dir,'team.sqlite'),{readOnly:true});
        assert.equal(db.prepare('SELECT COUNT(*) AS n FROM storage_held').get()!.n,0);db.close();
    } finally {await h.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
test('state.sqlite keeps confirmed, pending and refused across a damaged view and restart', async () => {
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-state-'));
    try {
        let s = new FileStateStore(pkg, { cloud: 'mac://studio', file: crypto.randomUUID(), name: 'Design', role: 'editor', author, state: stateFromFiles(doc) });
        const a = s.propose([{ k: 'set', id: 'Title', props: { content: { v: 'Local' } } }]);
        assert.ok(!('reject' in a));
        s.materialize();
        fs.writeFileSync(path.join(pkg, 'document.json'), '{}');
        s.close();
        s = new FileStateStore(pkg);
        assert.equal(s.replica.pending.length, 1);
        s.materialize();
        assert.match(fs.readFileSync(path.join(pkg, 'document.json'), 'utf8'), /Local/);
        s.replica.joined = true;
        await s.receive({ type: 'applied', actions: [{ ...a as any, first: 1, last: 1, by: author }] }, new MemoryObjects());
        assert.equal(s.replica.pending.length, 0);
        s.close();
        s = new FileStateStore(pkg);
        assert.equal(s.replica.seq, 1);
        assert.equal(materialize(s.replica.tree).document, materialize(s.replica.view()).document);
        assert.equal(s.db.prepare('PRAGMA synchronous').get()!.synchronous, 2);
        s.close();
    }
    finally {
        fs.rmSync(pkg, { recursive: true, force: true });
    }
});
test('an older host refusing a motion write leaves an actionable error in the replica', async () => {
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-motion-refusal-'));
    const store = new FileStateStore(pkg, { cloud: 'mac://studio', file: crypto.randomUUID(), name: 'Design', role: 'editor', author, state: stateFromFiles(doc) });
    try {
        const a = store.propose([{ k: 'set', id: 'Title', props: { motion: { v: [{ id: 'fade', on: 'boardHover', tracks: [{ prop: 'opacity', to: 0.5 }] }] } } }]);
        assert.ok(!('reject' in a));
        await store.receive({ type: 'reject', id: a.id, code: 'invalid', message: 'set on "Title": "motion" is not a text property' }, new MemoryObjects());
        assert.match(store.replica.refused.at(-1)!.message, /Cloud host runs an older Canvas and must be updated/);
        assert.equal(store.replica.view().node('Title')?.props.motion, undefined);
        const b = store.propose([{ k: 'set', id: 'Title', props: { motion: { v: [] } } }]);
        assert.ok(!('reject' in b));
        await store.receive({ type: 'reject', id: b.id, code: 'conflict', message: 'The layer changed' }, new MemoryObjects());
        assert.equal(store.replica.refused.at(-1)!.message, 'The layer changed');
        // A pasted or added layer whose child has motion: the older host refuses the insert.
        const c = store.propose([{ k: 'insert', parent: null, after: null, node: { id: 'Card', type: 'frame', children: [{ id: 'Dot', type: 'rectangle', motion: [{ id: 'fade', on: 'boardHover', tracks: [{ prop: 'opacity', to: 0.5 }] }] }] } }]);
        assert.ok(!('reject' in c));
        await store.receive({ type: 'reject', id: c.id, code: 'invalid', message: 'insert: "motion" is not a rectangle property' }, new MemoryObjects());
        assert.match(store.replica.refused.at(-1)!.message, /Cloud host runs an older Canvas and must be updated/);
        const d = store.propose([{ k: 'set', id: 'Title', props: { motion: { v: [{ id: 'fade', on: 'boardHover', tracks: [
            { prop: 'opacity', keys: [{ t: 12000, v: 1 }, { t: 13000, v: 0.5 }], from: 1, to: 0.5, delay: 12000, duration: 1000 },
        ] }] } } }]);
        assert.ok(!('reject' in d));
        await store.receive({ type: 'reject', id: d.id, code: 'invalid', message: 'node Title.motion[0].tracks[0]: delay must be 0 to 10000 ms' }, new MemoryObjects());
        assert.match(store.replica.refused.at(-1)!.message, /Cloud host runs an older Canvas and must be updated/);
        assert.equal(store.replica.view().node('Title')?.props.motion, undefined);
    } finally {
        store.close();
        fs.rmSync(pkg, { recursive: true, force: true });
    }
});
test('read-only gate covers all mutation families and permits reads and comments', () => {
    for (const p of ['/api/update', '/api/structure', '/api/move', '/api/resize', '/api/scale', '/api/text', '/api/replace', '/api/layout', '/api/overrides', '/api/pages', '/api/widgets', '/api/shaders', '/api/videos', '/api/images', '/api/history/undo', '/api/variations', '/api/agent/run']) {
        assert.ok(readOnlyRoute('POST', p), p);
        assert.equal(readOnlyRoute('GET', p), false);
    }
    assert.ok(MUTATING_ROUTES.length > 10);
    assert.equal(readOnlyRoute('POST', '/api/comments/ops'), false);
    for (const route of ['/api/widgets/visibility', '/api/widgets/shared/trust', '/api/widgets/shared/refresh']) {
        assert.equal(readOnlyRoute('POST', route), false, route);
        assert.equal(readOnlyRoute('DELETE', route), true, route);
    }
    assert.equal(readOnlyRoute('POST', '/api/widgets/shared/actions/change'), true);
});
test('Mac file routes persist snapshots, reject viewers and unregistered rooms before lookup', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-files-host-'));
    const h = new CloudHost({ dir, port: 0 });
    try {
        const token = h.ownerDevice('Anna');
        const base = `http://127.0.0.1:${await h.start()}`;
        const call = async (p: string, method = 'GET', body?: unknown, t = token) => {
            const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
            return { status: r.status, j: await r.json() as any };
        };
        const id = crypto.randomUUID();
        assert.equal((await call('/v1/files', 'POST', { id, name: 'Design' })).status, 201);
        assert.equal((await call('/v1/files')).j.files[0].name, 'Design');
        assert.equal((await call(`/v1/files/${id}/manifest`)).j.file, id);
        const stranger = crypto.randomUUID();
        assert.equal((await call(`/v1/files/${stranger}/manifest`)).status, 404);
        assert.equal(fs.existsSync(path.join(dir, 'files', `${stranger}.sqlite`)), false);
        const invite = h.invite('Ben', 'viewer');
        const vt = newSecret('ccd');
        assert.equal((await call('/v1/join', 'POST', { token: vt, device: 'A Mac' }, invite.code)).status, 200);
        assert.equal((await call('/v1/files', 'POST', { id: crypto.randomUUID(), name: 'No' }, vt)).status, 403);
        assert.equal((await call(`/v1/files/${id}`, 'PATCH', { name: 'No' }, vt)).status, 403);
        assert.equal((await call(`/v1/files/${id}/uploads`, 'POST', {}, vt)).status, 403);
        assert.equal((await call('/v1/usage')).j.adapter, 'mac');
        h.remove(invite.personId);
        assert.equal((await call('/v1/files', 'GET', undefined, vt)).status, 401);
    }
    finally {
        await h.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('snapshot manifests cannot name blobs outside the package', async () => {
    const { loadManifest } = await import('../cloud/core/files/snapshots.ts');
    const m = { format: 1, file: crypto.randomUUID(), seq: 0, epoch: 1, top: { children: null }, doc: {}, boards: [], widgets: [], pages: null, meta: {}, blobs: [{ path: '../../Library/item.plist', sha256: 'a'.repeat(64), bytes: 1, type: 'text/wgsl' }], vers: { sha256: 'b'.repeat(64) } };
    await assert.rejects(loadManifest(new MemoryObjects(), JSON.stringify(m)), /blob path/i);
});
test('Cloud rendering refuses remote and foreign media paths', async () => {
    const { sceneOf } = await import('../src/scene.ts');
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-confine-'));
    try {
        fs.mkdirSync(path.join(pkg, '.cloud'));
        fs.writeFileSync(path.join(pkg, '.cloud', 'state.sqlite'), '');
        for (const url of ['https://example.com/pixel.png','../outside.png','/Users/you/pixel.png','data:image/png;base64,AAAA']) {
            const scene = await sceneOf({ version: '2.21', children: [{ id: 'B', type: 'frame', width: 100, height: 100, fill: { type: 'image', url }, children: [] }] } as any, path.join(pkg, 'document.json'), 'B');
            assert.equal(scene.images.length, 0, 'foreign fill draws no image: '+url);
        }
    }
    finally {
        fs.rmSync(pkg, { recursive: true, force: true });
    }
});
test('Cloud links carry stable identity instead of a cache path', async () => {
    const { buildLink, parseLink } = await import('../src/page/link-logic.js');
    const file = crypto.randomUUID(), cloud = 'a'.repeat(16);
    const link = buildLink({ cloud, cloudFile: file, nodes: ['Board'] } as any)!;
    assert.ok(link);
    assert.equal(new URL(link).searchParams.get('cloud'), cloud);
    assert.equal((parseLink(link) as any).cloudFile, file);
});
test('Mac storage cap includes new file databases and snapshots', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cap-'));
    const h = new CloudHost({ dir, port: 0, storageCap: 1 } as any);
    try {
        const token = h.ownerDevice('Anna');
        const port = await h.start();
        const r = await fetch(`http://127.0.0.1:${port}/v1/files`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ id: crypto.randomUUID(), name: 'Full' }) });
        assert.equal(r.status, 429);
        assert.deepEqual(await r.json(), { code: 'quota', message: 'This Cloud is full. Delete files to make room.' });
    }
    finally {
        await h.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('confirmed and view share unchanged boards without mutating each other', () => {
    const pkg = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cow-'));
    try {
        const s = new FileStateStore(pkg, { cloud: 'mac://studio', file: crypto.randomUUID(), name: 'Design', role: 'editor', author, state: stateFromFiles({ children: [...doc.children, { id: 'Other', type: 'frame', children: [] }] }) });
        const confirmed = s.replica.tree.subtree('Other');
        s.propose([{ k: 'set', id: 'Title', props: { content: { v: 'Changed' } } }]);
        const view = s.replica.view();
        assert.equal(view.subtree('Other'), confirmed);
        assert.equal(s.replica.tree.node('Title')!.props.content, 'Hello');
        assert.equal(view.node('Title')!.props.content, 'Changed');
        s.close();
    }
    finally {
        fs.rmSync(pkg, { recursive: true, force: true });
    }
});
test('imports split large boards and insert component definitions before their users', async () => {
    const { importNodes } = await import('../src/cloud-files-import.ts');
    const ops = importNodes([{ id: 'Board', type: 'frame', children: [{ id: 'Instance', type: 'ref', ref: 'Component' }] }, { id: 'Component', type: 'frame', reusable: true, children: [] }]);
    assert.equal(ops.filter(o => o.k === 'insert').length, 3);
    assert.ok(ops.findIndex(o => o.k === 'insert' && o.node.id === 'Component') < ops.findIndex(o => o.k === 'insert' && o.node.id === 'Instance'));
});
test('snapshot decompression stops at the supplied byte budget', async () => {
    const { gzipText, gunzipText } = await import('../cloud/core/files/objects.ts');
    const gz = await gzipText('x'.repeat(4096));
    await assert.rejects(gunzipText(gz, 128), /limit|large/i);
});
test('an existing room cannot grow after its Cloud storage cap is lowered', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-edit-cap-'));
    let h = new CloudHost({ dir, port: 0 });
    try {
        const token = h.ownerDevice('Anna'), id = crypto.randomUUID();
        let port = await h.start();
        const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
        assert.equal((await fetch(`http://127.0.0.1:${port}/v1/files`, { method: 'POST', headers, body: JSON.stringify({ id, name: 'Design' }) })).status, 201);
        await h.stop();
        h = new CloudHost({ dir, port: 0, storageCap: 1 });
        port = await h.start();
        const a = { id: crypto.randomUUID(), epoch: 1, baseSeq: 0, ops: [{ k: 'insert', parent: null, after: null, node: { id: 'B', type: 'frame', children: [] } }] };
        const r = await fetch(`http://127.0.0.1:${port}/v1/files/${id}/sync`, { method: 'POST', headers, body: JSON.stringify({ type: 'actions', epoch: 1, actions: [a] }) });
        assert.equal(r.status, 429);
        const m = await (await fetch(`http://127.0.0.1:${port}/v1/files/${id}/manifest`, { headers })).json() as any;
        assert.equal(m.seq, 0);
    }
    finally {
        await h.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});
test('new pending action counts toward the offline byte cap', async () => {
    const { Replica, PENDING_CAP } = await import('../cloud/core/files/replica.ts');
    const cap = PENDING_CAP.bytes;
    PENDING_CAP.bytes = 128;
    try {
        const r = new Replica(author, stateFromFiles(doc), 0, 1);
        assert.ok('reject' in r.propose([{ k: 'set', id: 'Title', props: { content: { v: 'x'.repeat(200) } } }]));
        assert.equal(r.pending.length, 0);
    }
    finally {
        PENDING_CAP.bytes = cap;
    }
});
test('Mac multipart uploads verify hashes and serve only referenced bytes with private range headers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-multipart-')), h = new CloudHost({ dir, port: 0 });
    try {
        const token = h.ownerDevice('Anna'), base = `http://127.0.0.1:${await h.start()}`, headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
        const post = async (p: string, b: unknown) => { const r = await fetch(base + p, { method: 'POST', headers, body: JSON.stringify(b) }); assert.ok(r.ok, `${p}: ${r.status}`); return r.json() as Promise<any>; };
        const id = crypto.randomUUID();
        await post('/v1/files', { id, name: 'Design' });
        const bytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), sha = (await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
        const up = await post(`/v1/files/${id}/uploads`, { sha256: sha, bytes: bytes.length, type: 'image/png' });
        for (let n = 0; n < 2; n++)
            assert.equal((await fetch(`${base}/v1/files/${id}/uploads/${up.id}/parts/${n}`, { method: 'PUT', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/octet-stream' }, body: bytes.subarray(n * 4, n * 4 + 4) })).status, 200);
        await post(`/v1/files/${id}/uploads/${up.id}/complete`, {});
        assert.equal((await fetch(`${base}/v1/files/${id}/blobs/${sha}`, { headers })).status, 404);
        const a = { id: crypto.randomUUID(), epoch: 1, baseSeq: 0, ops: [{ k: 'blob', path: 'media/image.png', sha256: sha, bytes: bytes.length, type: 'image/png' }] };
        const out = await post(`/v1/files/${id}/sync`, { type: 'actions', epoch: 1, actions: [a] });
        assert.equal(out.messages.some((m: any) => m.type === 'reject'), false);
        const r = await fetch(`${base}/v1/files/${id}/blobs/${sha}`, { headers: { ...headers, range: 'bytes=0-3' } });
        assert.equal(r.status, 206);
        assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
        assert.match(r.headers.get('cache-control')!, /private/);
        assert.deepEqual(Buffer.from(await r.arrayBuffer()), bytes.subarray(0, 4));
    }
    finally {
        await h.stop();
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('MCP optional file arguments do not prevent fileless app commands',async()=>{
 const {tool}=await import('../mcp/tool.ts'),{z}=await import('zod');let callback:any;
 const old=process.env.CANVAS_MCP_NO_SPAWN,port=process.env.CANVAS_PORT;process.env.CANVAS_MCP_NO_SPAWN='1';process.env.CANVAS_PORT='1';
 try{tool({registerTool:(_n:any,_s:any,fn:any)=>{callback=fn;}} as any,'launch_canvas','Launch',{file:z.string().optional()},()=>({launched:true}));
 const out=await callback({},{});assert.equal(out.isError,undefined);assert.match(out.content[0].text,/launched/);
 }finally{if(old===undefined)delete process.env.CANVAS_MCP_NO_SPAWN;else process.env.CANVAS_MCP_NO_SPAWN=old;if(port===undefined)delete process.env.CANVAS_PORT;else process.env.CANVAS_PORT=port;}
});

test('removing a member terminates a blob download already in progress',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-stream-remove-')),h=new CloudHost({dir,port:0});
 try{const token=h.ownerDevice('Anna'),base=`http://127.0.0.1:${await h.start()}`,headers={authorization:`Bearer ${token}`,'content-type':'application/json'};
 const post=async(p:string,b:unknown,t=token)=>{const r=await fetch(base+p,{method:'POST',headers:{...headers,authorization:`Bearer ${t}`},body:JSON.stringify(b)});assert.ok(r.ok);return r.json() as Promise<any>;};
 const id=crypto.randomUUID();await post('/v1/files',{id,name:'Design'});const bytes=Buffer.alloc(12*1024*1024);bytes.set([137,80,78,71]);const sha=(await import('node:crypto')).createHash('sha256').update(bytes).digest('hex');
 const up=await post(`/v1/files/${id}/uploads`,{sha256:sha,bytes:bytes.length,type:'image/png'});await fetch(`${base}/v1/files/${id}/uploads/${up.id}`,{method:'PUT',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream'},body:bytes});
 await post(`/v1/files/${id}/sync`,{type:'actions',epoch:1,actions:[{id:crypto.randomUUID(),epoch:1,baseSeq:0,ops:[{k:'blob',path:'media/image.png',sha256:sha,bytes:bytes.length,type:'image/png'}]}]});
 const invite=h.invite('Ben','viewer'),viewer=newSecret('ccd');await post('/v1/join',{token:viewer,device:'A Mac'},invite.code);
 const r=await fetch(`${base}/v1/files/${id}/blobs/${sha}`,{headers:{authorization:`Bearer ${viewer}`}});h.remove(invite.personId);await assert.rejects(r.arrayBuffer());
 }finally{await h.stop();fs.rmSync(dir,{recursive:true,force:true});}
});
