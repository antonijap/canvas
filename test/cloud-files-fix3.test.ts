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
