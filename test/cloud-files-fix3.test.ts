import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {FileStateStore} from '../src/cloud-files-store.ts';
import {stateFromFiles} from '../cloud/core/files/state.ts';
import {memoryRoom} from '../cloud/core/files/memory.ts';
const state=()=>stateFromFiles({version:'2.21',children:[{id:'Board',type:'frame',children:[{id:'Title',type:'text',content:'abcd'}]}]});
test('typing generates confirmed-state splices and preserves concurrent text',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-typing-'));
 const a=new FileStateStore(path.join(dir,'a'),{cloud:'mac://studio',file:crypto.randomUUID(),name:'Design',role:'editor',author:{id:'anna',name:'Anna'},state:state()});
 const b=new FileStateStore(path.join(dir,'b'),{...a.meta,author:{id:'ben',name:'Ben'},state:state()});
 try{const room=memoryRoom(a.meta.file);room.seedState(state());
 const submit=(s:FileStateStore,text:string)=>{const action=s.propose([{k:'set',id:'Title',props:{content:{v:text}}}]);assert.ok(!('reject'in action));assert.equal(action.ops[0].k,'text');return action;};
 const x=submit(a,'Xabcd'),y=submit(b,'abcdY');
 for(const [s,action]of [[a,x],[b,y]] as const)assert.equal(room.submit({author:s.meta.author,role:'editor'},{type:'actions',epoch:1,actions:[action]}).replies[0].type,'ack');
 assert.equal(room.tree.node('Title')!.props.content,'XabcdY');
 const c=new FileStateStore(path.join(dir,'c'),{...b.meta,state:state()});try{const overlap=submit(c,'aZZd');const out=room.submit({author:c.meta.author,role:'editor'},{type:'actions',epoch:1,actions:[overlap]});assert.equal(out.replies[0].type,'ack');}finally{c.close();}
 }finally{a.close();b.close();fs.rmSync(dir,{recursive:true,force:true});}
});

import {CloudHost} from '../cloud/adapters/mac/host.ts';
async function hostTest(fn:(h:CloudHost,call:(p:string,method?:string,b?:unknown)=>Promise<Response>,dir:string)=>Promise<void>){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-fix3-host-')),h=new CloudHost({dir,port:0});
 try{const token=h.ownerDevice('Anna'),base='http://127.0.0.1:'+await h.start();await fn(h,(p,method='GET',b)=>fetch(base+p,{method,headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:b===undefined?undefined:JSON.stringify(b)}),dir);}finally{await h.stop();fs.rmSync(dir,{recursive:true,force:true});}
}
test('published files refuse import cancellation and demotion',()=>hostTest(async(h,call,dir)=>{
 const id=crypto.randomUUID();assert.equal((await call('/v1/files','POST',{id,name:'Design',importing:true})).status,201);
 assert.equal((await call(`/v1/files/${id}/import/complete`,'POST',{})).status,200);
 for(const method of ['DELETE','POST'])assert.equal((await call(`/v1/files/${id}/import`,method,{})).status,409);
 assert.equal((await call(`/v1/files/${id}`)).status,200);
 assert.equal((await call(`/v1/files/${id}`,'DELETE')).status,200);
 assert.equal(fs.existsSync(path.join(dir,'files',id+'.sqlite')),true);
}));

import {receive} from '../src/cloud-files.ts';
test('comment quota retries and other rejected drafts survive restart',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-comment-draft-'));
 const store=new FileStateStore(dir,{cloud:'mac://studio',file:crypto.randomUUID(),name:'Design',role:'editor',author:{id:'anna',name:'Anna'},state:state()});
 store.db.exec('CREATE TABLE comments_state(id INTEGER PRIMARY KEY,json TEXT NOT NULL)');
 const op={opId:crypto.randomUUID(),doc:store.meta.file,at:new Date().toISOString(),op:{kind:'thread.create',thread:crypto.randomUUID(),comment:crypto.randomUUID(),anchor:{nodeId:'Title',board:'Board',x:0,y:0},body:'Draft text'}};
 const s:any={store,status:'connected',chain:Promise.resolve(),stopped:false,offline:false,comments:[],commentsSeq:0,commentsPending:[op]};
 try{await receive(s,{type:'comments.ack',acks:[],rejected:[{opId:op.opId,code:'quota',message:'Try later'}]});assert.equal(s.commentsPending.length,1);assert.equal(s.status,'quota');
 await receive(s,{type:'comments.ack',acks:[],rejected:[{opId:op.opId,code:'invalid',message:'Anchor unavailable'}]});
 const saved=JSON.parse(String(store.db.prepare('SELECT json FROM comments_state').get()!.json));assert.equal(saved.commentsRejected[0].envelope.op.body,'Draft text');assert.match(fs.readFileSync(path.join(dir,'comments.json'),'utf8'),/Draft text/);
 }finally{clearTimeout(s.timer);store.close();fs.rmSync(dir,{recursive:true,force:true});}
});

import {prepareMove} from '../src/cloud-files-move.ts';
test('move keeps source edits made while publication is awaited',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-move-publish-')),source=path.join(dir,'Design.canvas'),dest=path.join(dir,'Cloud.canvas');fs.mkdirSync(source);fs.writeFileSync(path.join(source,'document.json'),JSON.stringify({version:'2.21',children:[]}));
 const oldHome=process.env.HOME;process.env.HOME=dir;
 try{await assert.rejects(prepareMove(source,async(name,doc,env)=>{fs.mkdirSync(dest);fs.writeFileSync(path.join(dest,'document.json'),JSON.stringify(doc));fs.writeFileSync(path.join(dest,'widgets.json'),JSON.stringify(env));return{id:crypto.randomUUID(),file:dest,name,cloud:'mac://studio',role:'editor'};},async()=>{await Promise.resolve();fs.writeFileSync(path.join(source,'document.json'),JSON.stringify({version:'2.21',children:[{id:'New',type:'frame'}]}));}),/changed during the move/);assert.match(fs.readFileSync(path.join(source,'document.json'),'utf8'),/New/);
 }finally{if(oldHome===undefined)delete process.env.HOME;else process.env.HOME=oldHome;fs.rmSync(dir,{recursive:true,force:true});}
});

test('multipart total cannot exceed reservation and closed parts are swept',()=>hostTest(async(h,call,dir)=>{
 const id=crypto.randomUUID();await call('/v1/files','POST',{id,name:'Design'});
 const up=await (await call(`/v1/files/${id}/uploads`,'POST',{bytes:8,type:'image/png',sha256:'a'.repeat(64)})).json() as any;
 const token=h.ownerDevice('Anna'),port=(h as any).server.address().port;
 const put=(part:number)=>fetch(`http://127.0.0.1:${port}/v1/files/${id}/uploads/${up.id}/parts/${part}`,{method:'PUT',headers:{authorization:'Bearer '+token},body:new Uint8Array(8)});
 assert.equal((await put(0)).status,200);assert.equal((await put(1)).status,413);
 const room=(h.files as any).rooms.get(id);room.store.sql.exec("UPDATE uploads SET state='stored' WHERE id=?",up.id);
 h.files.sweepParts();assert.equal(fs.existsSync(path.join(dir,'uploads',id,up.id)),false);
 const orphan=path.join(dir,'uploads',crypto.randomUUID(),'gone');fs.mkdirSync(orphan,{recursive:true});fs.writeFileSync(path.join(orphan,'0'),'leftover');h.files.sweepParts();assert.equal(fs.existsSync(orphan),false);
}));

test('capacity uses accounted bytes between timed recounts',()=>hostTest(async(h,call,dir)=>{
 const original=fs.readdirSync;let walks=0;(fs as any).readdirSync=(p:any,...args:any[])=>{if(String(p)===dir)walks++;return (original as any)(p,...args);};
 try{for(let i=0;i<50;i++)(h.files as any).capacity(0);assert.equal(walks,0);const before=(h.files as any).usedBytes;
 const key=`files/${crypto.randomUUID()}/blobs/${'b'.repeat(64)}`;await h.files.objects.putIfAbsent(key,new Uint8Array(123));assert.equal((h.files as any).usedBytes,before+123);await h.files.objects.delete(key);assert.equal((h.files as any).usedBytes,before);
 }finally{fs.readdirSync=original;}
}));

test('rejected action batch creates one recovered package with every draft',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-reject-batch-')),old=process.env.HOME;process.env.HOME=dir;
 const store=new FileStateStore(path.join(dir,'cache.canvas'),{cloud:'mac://studio',file:crypto.randomUUID(),name:'Design',role:'editor',author:{id:'anna',name:'Anna'},state:state()});
 const a=store.propose([{k:'set',id:'Board',props:{x:{v:1}}}]),b=store.propose([{k:'set',id:'Board',props:{y:{v:2}}}]);assert.ok(!('reject'in a)&&!('reject'in b));
 const s:any={store,status:'connected',chain:Promise.resolve(),stopped:false,offline:false,comments:[],commentsSeq:0,commentsPending:[]};
 try{for(const action of [a,b])await receive(s,{type:'reject',id:action.id,code:'conflict',message:'Changed remotely'});
 const root=path.join(dir,'Documents','Canvas Recovered'),copies=fs.readdirSync(root);assert.equal(copies.length,1);const archive=fs.readFileSync(path.join(root,copies[0],'unsent-actions.json'),'utf8');assert.ok(archive.includes(a.id)&&archive.includes(b.id));
 }finally{store.close();if(old===undefined)delete process.env.HOME;else process.env.HOME=old;fs.rmSync(dir,{recursive:true,force:true});}
});

import net from 'node:net';
test('file upgrades and hellos spend a shared person budget across reconnects',()=>hostTest(async(h,call)=>{
 const id=crypto.randomUUID();await call('/v1/files','POST',{id,name:'Design'});const me=await(await call('/v1/me')).json() as any,token=h.ownerDevice('Anna'),port=(h as any).server.address().port;
 const bank=(h.files as any).bank,now=Date.now(),ws=new WebSocket(`ws://127.0.0.1:${port}/v1/files/${id}/socket`,{headers:{authorization:'Bearer '+token}} as unknown as string[]);
 try{await new Promise<void>((r,j)=>{ws.addEventListener('open',()=>r(),{once:true});ws.addEventListener('error',j,{once:true});});assert.equal(bank.granted(me.id,'messages',now),1);
 const welcome=new Promise<void>((r,j)=>{const timer=setTimeout(()=>j(Error('Missing welcome')),2000);ws.addEventListener('message',e=>{if(JSON.parse(String(e.data)).type==='welcome'){clearTimeout(timer);r();}});});ws.send(JSON.stringify({type:'hello',protocol:2,file:id,since:0,epoch:1,pending:[]}));await welcome;assert.equal(bank.granted(me.id,'messages',now),2);
 bank.grant(me.id,'messages',120,now);ws.close();
 const status=await new Promise<string>((r,j)=>{const socket=net.connect(port,'127.0.0.1',()=>socket.write([`GET /v1/files/${id}/socket HTTP/1.1`,'Host: 127.0.0.1','Upgrade: websocket','Connection: Upgrade','Sec-WebSocket-Version: 13',`Sec-WebSocket-Key: ${Buffer.alloc(16).toString('base64')}`,`Authorization: Bearer ${token}`,'',''].join('\r\n')));socket.on('data',b=>{r(String(b).split('\r\n')[0]);socket.destroy();});socket.on('error',j);});assert.match(status,/429/);
 }finally{ws.close();}
}));

test('import budgets belong to each person and stale imports free storage',()=>hostTest(async(h,call,dir)=>{
 const id=crypto.randomUUID(),live=crypto.randomUUID();await call('/v1/files','POST',{id,name:'Import',importing:true});await call('/v1/files','POST',{id:live,name:'Design'});
 const room=(h.files as any).rooms.get(id);assert.equal(room.leases.take('anna','ops',6000),true);assert.equal(room.leases.take('ben','ops',1),true);
 const up=await(await call(`/v1/files/${id}/uploads`,'POST',{bytes:8,type:'image/png',sha256:'a'.repeat(64)})).json() as any;
 const folder=path.join(dir,'uploads',id,up.id);fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(folder,'0'),'leftover');
 (h.files as any).db.sql.exec('UPDATE files SET created_at=?',new Date(Date.now()-25*60*60*1000).toISOString());
 await h.files.expireImports();assert.equal((await call(`/v1/files/${id}`)).status,404);assert.equal(fs.existsSync(path.join(dir,'files',id+'.sqlite')),false);assert.equal(fs.existsSync(path.join(dir,'objects','files',id)),false);assert.equal(fs.existsSync(folder),false);assert.equal((h.files as any).ledger.held(),0);assert.equal((await call(`/v1/files/${live}`)).status,200);
}));

test('overlapping text rejection keeps the second persons full text in the recovered copy',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-overlap-copy-')),old=process.env.HOME;process.env.HOME=dir;
 const store=new FileStateStore(path.join(dir,'cache.canvas'),{cloud:'mac://studio',file:crypto.randomUUID(),name:'Design',role:'editor',author:{id:'ben',name:'Ben'},state:state()});
 const a=store.propose([{k:'set',id:'Title',props:{content:{v:'aYYd'}}}]);assert.ok(!('reject'in a));store.replica.joined=true;
 const s:any={store,status:'connected',chain:Promise.resolve(),stopped:false,offline:false,comments:[],commentsSeq:0,commentsPending:[]};
 try{const room=memoryRoom(store.meta.file);room.seedState(state());const remote=room.submit({author:{id:'anna',name:'Anna'},role:'editor'},{type:'actions',epoch:1,actions:[{id:crypto.randomUUID(),at:'',baseSeq:0,epoch:1,ops:[{k:'text',id:'Title',baseSeq:0,from:1,del:2,ins:'XX'}]}]});await receive(s,{type:'applied',actions:remote.applied});const out=room.submit({author:store.meta.author,role:'editor'},{type:'actions',epoch:1,actions:[a]});assert.equal(out.replies[0].type,'reject');await receive(s,out.replies[0]);
 const root=path.join(dir,'Documents','Canvas Recovered'),copy=path.join(root,fs.readdirSync(root)[0]);assert.match(fs.readFileSync(path.join(copy,'document.json'),'utf8'),/aYYd/);assert.equal(store.replica.tree.node('Title')!.props.content,'aXXd');
 }finally{store.close();if(old===undefined)delete process.env.HOME;else process.env.HOME=old;fs.rmSync(dir,{recursive:true,force:true});}
});

test('typing splices transform automatic span shifts and empty style arrays',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-typing-style-')),stores:FileStateStore[]=[];
 try{for(const styled of [false,true]){
 const initial=state();if(styled)(initial.children[0] as any).children[0].spans=[{start:1,end:3,fontWeight:'700'}];
 const room=memoryRoom(crypto.randomUUID());room.seedState(initial);
 for(const [i,text]of ['Xabcd','abcdY'].entries()){
 const s=new FileStateStore(path.join(dir,`${styled}-${i}`),{cloud:'mac://studio',file:room.file,name:'Design',role:'editor',author:{id:i?'ben':'anna',name:i?'Ben':'Anna'},state:initial});stores.push(s);
 const spans=styled?[{start:i?1:2,end:i?3:4,fontWeight:'700'}]:[];const action=s.propose([{k:'set',id:'Title',props:{content:{v:text},spans:{v:spans},lists:{v:[]}}}]);assert.ok(!('reject'in action));assert.equal(room.submit({author:s.meta.author,role:'editor'},{type:'actions',epoch:1,actions:[action]}).replies[0].type,'ack');
 }assert.equal(room.tree.node('Title')!.props.content,'XabcdY');
 }}finally{for(const s of stores)s.close();fs.rmSync(dir,{recursive:true,force:true});}
});

test('conditional text undo still checks the last writer',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'canvas-text-undo-')),store=new FileStateStore(dir,{cloud:'mac://studio',file:crypto.randomUUID(),name:'Design',role:'editor',author:{id:'anna',name:'Anna'},state:state()});
 try{store.replica.confirm([{id:crypto.randomUUID(),first:1,last:1,by:{id:'ben',name:'Ben'},at:'',ops:[{k:'set',id:'Title',props:{content:{v:'Changed by Ben'}}}]}]);const out=store.propose([{k:'set',id:'Title',props:{content:{v:'abcd'}},if:{content:0}}]);assert.ok('reject'in out);assert.equal(out.reject,'conflict');
 }finally{store.close();fs.rmSync(dir,{recursive:true,force:true});}
});
