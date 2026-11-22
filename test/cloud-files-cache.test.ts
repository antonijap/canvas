import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeBoardCheckpoint,evictClosedPackages} from '../src/cloud-files-cache.ts';
import {FileStateStore} from '../src/cloud-files-store.ts';
import {stateFromFiles} from '../cloud/core/files/state.ts';
import {cloudFiles, cloudKey, fileEvents, fileSession, openCloudFile} from '../src/cloud-files.ts';
import {closeTunnel, setToken} from '../src/cloud.ts';
import {cloudFileHooks} from '../src/cloud-files-runtime.ts';
import {hostedUrl, resetCloudConfig, setCloudConfig} from '../src/cloud-config.ts';
import {writeJoined} from '../src/cloud-secrets.ts';
import {genkey, serve} from '../src/cloud-tunnel.ts';
import {CloudHost, newSecret} from '../cloud/adapters/mac/host.ts';

test('a configured Cloud opens its local replica when the host is unreachable', async (t) => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-offline-open-')));
  const cloud = 'http://127.0.0.1:9191';
  const id = crypto.randomUUID();
  const pkg = path.join(dir, 'Library', 'Application Support', 'Canvas', 'cloud-files', cloudKey(cloud), id + '.canvas');
  const oldHome = process.env.HOME;
  process.env.HOME = dir;
  const get = t.mock.method(globalThis, 'fetch', async () => { throw new Error('Host unreachable'); });
  setCloudConfig({ clouds: [{ url: cloud, devEmail: 'editor@example.test' }] });
  try {
    const store = new FileStateStore(pkg, {
      cloud, file: id, name: 'Design', role: 'editor', author: { id: 'editor', name: 'Editor' },
      state: stateFromFiles({ children: [] }),
    });
    store.materialize();
    store.close();
    const opened = await openCloudFile(cloud, id);
    assert.equal(opened.file, pkg);
    assert.equal(opened.name, 'Design');
    assert.ok(get.mock.calls.length <= 1, 'background sync can attempt to reconnect');
    setCloudConfig({ clouds: [] });
    await assert.rejects(() => openCloudFile(cloud, id), /Cloud is not added/);
  } finally {
    setCloudConfig({ clouds: [] });
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    resetCloudConfig();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('reopening a Cloud replica keeps a verified view and rebuilds changed bytes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-replica-view-'));
  const pkg = path.join(dir, 'copy.canvas');
  const doc = path.join(pkg, 'document.json');
  const view = new FileStateStore(pkg, {
    cloud: 'mac://studio', file: crypto.randomUUID(), name: 'Design', role: 'editor',
    author: { id: 'editor', name: 'Editor' }, state: stateFromFiles({ children: [] }),
  });
  try {
    view.materialize();
    const bytes = fs.readFileSync(doc, 'utf8');
    const inode = fs.statSync(doc).ino;
    view.restoreView();
    assert.equal(fs.statSync(doc).ino, inode);
    fs.writeFileSync(doc, bytes.replace('2.21', '2.22'));
    view.restoreView();
    assert.equal(fs.readFileSync(doc, 'utf8'), bytes);
    view.commit(); // a crash between the durable commit and materialize clears the old hash
    view.restoreView();
    assert.ok(view.db.prepare('SELECT view_hash FROM meta').get()?.view_hash);
  } finally {
    view.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
test('board checkpoints verify hashes and reuse unchanged objects',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-boards-'));
 try{const children=[{id:'Board',type:'frame',children:[]}];const a=writeBoardCheckpoint(dir,children),b=writeBoardCheckpoint(dir,children);assert.deepEqual(a,b);assert.equal(fs.readdirSync(dir).length,1);fs.writeFileSync(path.join(dir,a[0].sha256+'.json.gz'),'broken');assert.throws(()=>writeBoardCheckpoint(dir,children),/hash|invalid|incorrect/i);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('eviction preserves open packages and every pending action',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-evict-'));
 try{const cloud=path.join(dir,'a'.repeat(16));fs.mkdirSync(cloud);const packages=Array.from({length:3},()=>path.join(cloud,crypto.randomUUID()+'.canvas'));
 for(const [i,p]of packages.entries()){const s=new FileStateStore(p,{cloud:'mac://studio',file:path.basename(p,'.canvas'),name:'Design',role:'editor',author:{id:'anna',name:'Anna'},state:stateFromFiles({children:[{id:'Board',type:'frame',children:[]}]})});if(i===1)s.propose([{k:'set',id:'Board',props:{name:{v:'Waiting'}}}]);s.materialize();s.close();}
 evictClosedPackages(dir,new Set([packages[2]]),0);assert.equal(fs.existsSync(packages[0]),false);assert.equal(fs.existsSync(packages[1]),true);assert.equal(fs.existsSync(packages[2]),true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('move imports legacy media names and leaves derived posters out',async()=>{
 const {prepareMove}=await import('../src/cloud-files-move.ts');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-move-legacy-')),old=process.env.HOME;process.env.HOME=dir;
 try{const source=path.join(dir,'Design.canvas'),dest=path.join(dir,'Cloud.canvas');fs.mkdirSync(path.join(source,'media','posters'),{recursive:true});const bytes=Buffer.from([137,80,78,71]);fs.writeFileSync(path.join(source,'media','My image.png'),bytes);fs.writeFileSync(path.join(source,'media','posters','derived.png'),bytes);fs.writeFileSync(path.join(source,'document.json'),JSON.stringify({version:'2.21',children:[{id:'B',type:'frame',fill:{type:'image',url:'media/My image.png'},children:[]}]}));
 const out=await prepareMove(source,async(name,doc,envelope,blobs)=>{fs.mkdirSync(dest);fs.writeFileSync(path.join(dest,'document.json'),JSON.stringify(doc));fs.writeFileSync(path.join(dest,'widgets.json'),JSON.stringify(envelope));for(const b of blobs){fs.mkdirSync(path.dirname(path.join(dest,b.op.path)),{recursive:true});fs.writeFileSync(path.join(dest,b.op.path),b.bytes);}return{id:crypto.randomUUID(),file:dest,name,cloud:'mac://studio',role:'editor'};});
 assert.equal(out.verified,true);assert.equal(fs.existsSync(source),false);const text=fs.readFileSync(path.join(dest,'document.json'),'utf8');assert.doesNotMatch(text,/My image/);assert.match(text,/media\/[a-f0-9]{64}\.png/);assert.equal(fs.existsSync(path.join(dest,'media','posters')),false);
 }finally{if(old===undefined)delete process.env.HOME;else process.env.HOME=old;fs.rmSync(dir,{recursive:true,force:true});}
});

test('board objects are collected by durable references and count toward eviction',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-board-gc-')),root=path.join(dir,'packages'),cache=path.join(dir,'boards'),cloud='a'.repeat(16),pkg=path.join(root,cloud,crypto.randomUUID()+'.canvas');
 const s=new FileStateStore(pkg,{cloud:'mac://studio',file:path.basename(pkg,'.canvas'),name:'Design',role:'editor',author:{id:'anna',name:'Anna'},state:stateFromFiles({children:[{id:'Board',type:'frame',name:'First',children:[]}]})});
 try{const boardDir=path.join(cache,cloud,'boards');s.checkpoint(boardDir);const old=fs.readdirSync(boardDir)[0];const a=s.propose([{k:'set',id:'Board',props:{name:{v:'Second'}}}]);assert.ok(!('reject'in a));s.replica.confirm([{...a,first:1,last:1,by:s.meta.author}]);s.commit();s.checkpoint(boardDir);s.close();
 evictClosedPackages(root,new Set([pkg]),Number.MAX_SAFE_INTEGER,cache);assert.equal(fs.existsSync(path.join(boardDir,old)),false);assert.equal(fs.readdirSync(boardDir).length,1);
 const packageBytes=(p:string):number=>fs.readdirSync(p,{withFileTypes:true}).reduce((n,e)=>n+(e.isDirectory()?packageBytes(path.join(p,e.name)):fs.statSync(path.join(p,e.name)).size),0);
 evictClosedPackages(root,new Set(),packageBytes(pkg),cache);assert.equal(fs.existsSync(pkg),false);assert.equal(fs.readdirSync(boardDir).length,0);
 }finally{try{s.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});}
});

test('cache eviction keeps permanently rejected comment drafts',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-rejected-cache-')),pkg=path.join(dir,'a'.repeat(16),crypto.randomUUID()+'.canvas');
 const s=new FileStateStore(pkg,{cloud:'mac://studio',file:path.basename(pkg,'.canvas'),name:'Design',role:'editor',author:{id:'anna',name:'Anna'},state:stateFromFiles({children:[]})});
 try{s.db.exec('CREATE TABLE comments_state(id INTEGER PRIMARY KEY,json TEXT NOT NULL)');s.db.prepare('INSERT INTO comments_state VALUES(1,?)').run(JSON.stringify({commentsPending:[],commentsRejected:[{envelope:{opId:'draft',op:{body:'Keep this draft'}},code:'invalid',message:'Retry'}]}));s.close();evictClosedPackages(dir,new Set(),0,path.join(dir,'boards'));assert.equal(fs.existsSync(pkg),true);
 }finally{try{s.close();}catch{}fs.rmSync(dir,{recursive:true,force:true});}
});

for (const scenario of ['missing file', 'old host', 'role downgrade', 'forbidden'] as const) {
  test(`cached open revalidates Cloud access: ${scenario}`, async (t) => {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cache-check-')));
    const cloud = 'http://127.0.0.1:9192', id = crypto.randomUUID();
    const pkg = path.join(dir, 'Library', 'Application Support', 'Canvas', 'cloud-files', cloudKey(cloud), id + '.canvas');
    const oldHome = process.env.HOME;
    process.env.HOME = dir;
    let missing = scenario === 'missing file';
    const role = scenario === 'role downgrade' ? 'viewer' : 'editor';
    const socket = t.mock.method(globalThis, 'WebSocket', function () {
      return { addEventListener() {}, close() {} };
    });
    t.mock.method(globalThis, 'fetch', async (input: string) => {
      const { pathname } = new URL(input);
      if (pathname === '/v1/me') return Response.json({ role });
      if (pathname === '/v1/files') {
        if (scenario === 'forbidden') return Response.json({}, { status: 403 });
        return Response.json({ files: missing ? [] : [{ id, name: 'Restored' }], role: scenario === 'old host' ? undefined : role });
      }
      if (missing || scenario === 'old host') return Response.json({}, { status: 404 });
      return Response.json({ id, name: 'Restored' });
    });
    setCloudConfig({ clouds: [{ url: cloud, devEmail: 'anna@example.test' }] });
    let removed = 0, notifiedRole: string | undefined;
    fileEvents.removed = () => { removed++; };
    fileEvents.view = file => { notifiedRole = fileSession(file)?.store.meta.role; };
    try {
      const store = new FileStateStore(pkg, {
        cloud, file: id, name: 'Cached', role: 'editor', author: { id: 'anna', name: 'Anna' },
        state: stateFromFiles({ children: [{ id: 'Board', type: 'frame' }] }),
      });
      if (missing || scenario === 'forbidden') store.propose([{ k: 'set', id: 'Board', props: { name: { v: 'Draft' } } }]);
      store.materialize();
      store.close();
      if (missing || scenario === 'forbidden') {
        await assert.rejects(() => openCloudFile(cloud, id), {
          status: missing ? 404 : 403,
        });
        assert.equal(removed, 1);
        const recovered = path.join(dir, 'Documents', 'Canvas Recovered');
        assert.match(fs.readFileSync(path.join(recovered, fs.readdirSync(recovered)[0], 'unsent-actions.json'), 'utf8'), /Draft/);
        if (scenario === 'forbidden') {
          assert.equal(socket.mock.calls.length, 0);
          assert.equal(fs.existsSync(pkg), false);
          await assert.rejects(() => openCloudFile(cloud, id), /membership was removed/);
          return;
        }
        await assert.rejects(() => openCloudFile(cloud, id), { status: 404 });
        assert.equal(fs.readdirSync(recovered).length, 1);
        missing = false;
        await openCloudFile(cloud, id);
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(fileSession(pkg)?.store.meta.name, 'Restored');
      } else {
        assert.equal((await openCloudFile(cloud, id)).role, role);
        assert.equal(removed, 0);
        if (role === 'viewer') {
          assert.equal(notifiedRole, 'viewer');
          const assertEdit = cloudFileHooks.assertEdit;
          assert.ok(assertEdit);
          assert.throws(() => assertEdit(path.join(pkg, 'document.json')), /read only/);
        }
      }
      assert.equal(socket.mock.calls.length, 1);
    } finally {
      delete fileEvents.removed;
      delete fileEvents.view;
      setCloudConfig({ clouds: [] });
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
      resetCloudConfig();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

for (const signingOut of [false, true]) {
  test(signingOut ? 'sign-out during hosted connect keeps the cache' : 'a Mac host 401 clears cached files and recovers drafts once', async (t) => {
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-hosted-cache-')));
    const bin = path.resolve(import.meta.dirname, 'fixtures/fake-tunnel.sh');
    const env = {
      CANVAS_TUNNEL_BIN: bin, CANVAS_FAKE_TUNNEL_DIR: home,
      CANVAS_FAKE_TUNNEL_NODE: process.execPath, CANVAS_FAKE_TUNNEL_ANY_PORT: '1',
      CANVAS_CLOUD_SECRETS_FILE: path.join(home, 'secrets.json'),
    };
    const oldEnv = new Map(Object.keys(env).map(name => [name, process.env[name]]));
    Object.assign(process.env, env);
    t.mock.method(os, 'homedir', () => home);
    const host = new CloudHost({ dir: path.join(home, 'host'), port: 0 });
    let tunnel: Awaited<ReturnType<typeof serve>> | undefined;
    try {
      const port = await host.start();
      host.ownerDevice('Anna');
      const { code } = host.invite('Ben');
      const token = newSecret('ccd');
      const joined = await fetch(`http://127.0.0.1:${port}/v1/join`, {
        method: 'POST', headers: { authorization: `Bearer ${code}`, 'content-type': 'application/json' },
        body: JSON.stringify({ token, device: 'Test Mac' }),
      });
      assert.equal(joined.status, 200);
      const { me } = await joined.json() as { me: { id: string } };
      const hostKey = await genkey(bin, 'server');
      tunnel = await serve(bin, hostKey.key, null, port);
      const cloud = hostedUrl(host.hostId()), id = crypto.randomUUID();
      assert.ok(await writeJoined(host.hostId(), { token, addr: tunnel.addr, key: (await genkey(bin, 'client')).key, memberKey: hostKey.public }));
      setCloudConfig({ clouds: [{ url: cloud }] });
      const cache = path.join(home, 'Library', 'Application Support', 'Canvas', 'cloud-files', cloudKey(cloud));
      const boards = path.join(home, 'Library', 'Caches', 'Canvas', 'cloud', cloudKey(cloud));
      const pkg = path.join(cache, id + '.canvas');
      for (const file of [id, crypto.randomUUID()]) {
        const store = new FileStateStore(path.join(cache, file + '.canvas'), {
          cloud, file, name: 'Design', role: 'editor', author: { id: me.id, name: 'Ben' },
          state: stateFromFiles({ children: [{ id: 'Board', type: 'frame' }] }),
        });
        if (file === id) store.propose([{ k: 'set', id: 'Board', props: { name: { v: 'Draft' } } }]);
        store.materialize();
        store.close();
      }
      assert.ok(host.remove(me.id));
      const fetchHost = globalThis.fetch;
      let refusal: { status: number; code: string } | undefined;
      const requests = t.mock.method(globalThis, 'fetch', async (input: string, init: RequestInit) => {
        const answer = await fetchHost(input, init);
        refusal = { status: answer.status, code: (await answer.clone().json() as { code: string }).code };
        if (signingOut) setToken(cloud, null);
        return answer;
      });
      if (signingOut) {
        assert.equal((await openCloudFile(cloud, id)).file, pkg);
        assert.deepEqual(refusal, { status: 401, code: 'unauthenticated' });
        assert.ok(fs.existsSync(pkg));
        assert.ok(fs.existsSync(boards));
        assert.equal(fileSession(pkg)?.store.replica.pending.length, 1);
        assert.ok(!fs.existsSync(path.join(home, 'Documents', 'Canvas Recovered')));
      } else {
        const opened = openCloudFile(cloud, id);
        await assert.rejects(opened, { status: 403, code: 'removed' });
        assert.deepEqual(refusal, { status: 401, code: 'unauthenticated' });
        assert.ok(!fs.existsSync(cache));
        assert.ok(!fs.existsSync(boards));
        await assert.rejects(() => cloudFiles(cloud), { status: 403, code: 'removed' });
        const recovered = path.join(home, 'Documents', 'Canvas Recovered');
        const copies = fs.readdirSync(recovered);
        assert.equal(copies.length, 1);
        assert.match(fs.readFileSync(path.join(recovered, copies[0], 'unsent-actions.json'), 'utf8'), /Draft/);
      }
      assert.equal(requests.mock.calls.length, 1);
    } finally {
      setCloudConfig({ clouds: [] });
      resetCloudConfig();
      closeTunnel(host.hostId());
      tunnel?.helper.stop();
      await host.stop();
      for (const [name, value] of oldEnv) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}

for (const scenario of ['sign-out during file listing', 'socket closes during import'] as const) {
  test(scenario, async (t) => {
    const originalHome = process.env.HOME;
    const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-cache-race-')));
    process.env.HOME = home;
    const cloud = 'http://127.0.0.1:9193', id = crypto.randomUUID();
    const pkg = path.join(home, 'Library', 'Application Support', 'Canvas', 'cloud-files', cloudKey(cloud), id + '.canvas');
    const signingOut = scenario === 'sign-out during file listing';
    const listed = Response.json({ files: signingOut ? [{ id, name: 'Design' }] : [], role: 'editor' });
    let started!: () => void;
    const requestStarted = new Promise<void>(resolve => { started = resolve; });
    let finishList!: (response: Response) => void;
    const firstList = new Promise<Response>(resolve => { finishList = resolve; });
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async () => {
      started();
      if (signingOut && requests++ === 0) return firstList;
      return listed.clone();
    });
    const sockets: EventTarget[] = [];
    t.mock.method(globalThis, 'WebSocket', function () {
      const socket = Object.assign(new EventTarget(), { close() { socket.dispatchEvent(new Event('close')); } });
      sockets.push(socket);
      return socket;
    });
    setCloudConfig({ clouds: [{ url: cloud, devEmail: 'editor@example.test' }] });
    try {
      const store = new FileStateStore(pkg, {
        cloud, file: id, name: 'Design', role: 'editor', author: { id: 'editor', name: 'Editor' },
        state: stateFromFiles({ children: [] }),
      });
      store.materialize();
      store.close();
      const session = fileSession(pkg, !signingOut)!;
      await requestStarted;
      if (signingOut) {
        setToken(cloud, null);
        finishList(Response.json({}, { status: 403 }));
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(fs.existsSync(pkg), true);
        setToken(cloud, 'test-token');
        assert.equal((await openCloudFile(cloud, id)).file, pkg);
      } else {
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(sockets.length, 1);
        t.mock.timers.enable({ apis: ['setTimeout'] });
        sockets[0].dispatchEvent(new Event('close'));
        t.mock.timers.tick(500);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(session.stopped, false);
        assert.equal(sockets.length, 2);
        sockets[1].dispatchEvent(new Event('close'));
        t.mock.timers.tick(500);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(sockets.length, 2, 'the second retry waits longer');
        t.mock.timers.tick(500);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(sockets.length, 3);
        sockets[2].dispatchEvent(new MessageEvent('message', { data: JSON.stringify({
          type: 'welcome', protocol: 2, role: 'editor', me: { id: 'editor', name: 'Editor' },
          epoch: 1, seq: 0, known: [], limits: { opsPerMessage: 1000, actionBytes: 100_000 },
        }) }));
        await session.chain;
        assert.equal(session.status, 'connected');
        sockets[2].dispatchEvent(new Event('close'));
        t.mock.timers.tick(500);
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(sockets.length, 4, 'a welcome resets the retry delay');
      }
    } finally {
      setToken(cloud, null);
      setCloudConfig({ clouds: [] });
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
      resetCloudConfig();
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
}
