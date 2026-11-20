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
