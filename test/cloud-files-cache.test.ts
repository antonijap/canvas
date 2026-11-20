import assert from 'node:assert/strict';
import {test} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {writeBoardCheckpoint,evictClosedPackages} from '../src/cloud-files-cache.ts';
import {FileStateStore} from '../src/cloud-files-store.ts';
import {stateFromFiles} from '../cloud/core/files/state.ts';
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
