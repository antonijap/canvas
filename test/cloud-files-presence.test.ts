import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CloudHost, newSecret } from '../cloud/adapters/mac/host.ts';
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
test('file sockets stamp presence, filter viewers, cap traffic and remove closed peers', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'canvas-presence-'));
    const h = new CloudHost({ dir, port: 0 });
    const sockets: WebSocket[] = [];
    const until = async (f: () => boolean) => { const end=Date.now()+2000; while(!f()) { if(Date.now()>end) assert.fail('presence not relayed'); await sleep(10); } };
    try {
        const token=h.ownerDevice('Anna'), base='http://127.0.0.1:'+await h.start();
        const call = async (p:string, body:unknown, auth=token) => { const r=await fetch(base+p,{method:'POST',headers:{authorization:'Bearer '+auth,'content-type':'application/json'},body:JSON.stringify(body)}); assert.ok(r.ok); return r.json(); };
        const file=crypto.randomUUID(); await call('/v1/files',{id:file,name:'Design'});
        const inv=h.invite('Ben','editor'), peer=newSecret('ccd');
        await call('/v1/join',{token:peer,device:'A Mac'},inv.code);
        async function open(auth:string) {
            const ws=new WebSocket(base.replace('http:','ws:')+`/v1/files/${file}/socket`, {headers:{authorization:'Bearer '+auth}} as unknown as string[]);
            sockets.push(ws); const messages:any[]=[];
            ws.addEventListener('message',e=>messages.push(JSON.parse(String(e.data))));
            await new Promise<void>((resolve,reject)=>{ws.addEventListener('open',()=>resolve(),{once:true});ws.addEventListener('error',reject,{once:true});});
            ws.send(JSON.stringify({type:'hello',protocol:2,file,since:0,epoch:1,pending:[]}));
            await until(()=>messages.some(m=>m.type==='welcome')); return {ws,messages};
        }
        const a=await open(token), b=await open(peer);
        b.ws.send(JSON.stringify({type:'presence',p:{cursor:{x:10,y:20},sel:['Board'],by:{name:'Forged'},preview:{kind:'move',ids:['Board'],dx:4}}}));
        await until(()=>a.messages.some(m=>m.type==='presence' && m.peers.some((p:any)=>p.cursor?.x===10)));
        const first=a.messages.find(m=>m.type==='presence').peers[0];
        assert.equal(first.by.name,'Ben'); assert.equal(first.by.id,inv.personId); assert.equal(first.role,'editor'); assert.equal(first.preview.dx,4);
        assert.equal(b.messages.filter(m=>m.type==='presence' && m.peers.some((p:any)=>p.by.id===inv.personId)).length,0);
        for(let i=0;i<25;i++) b.ws.send(JSON.stringify({type:'presence',p:{cursor:{x:i,y:0}}}));
        await sleep(150);
        assert.ok(a.messages.filter(m=>m.type==='presence').length<=10);
        h.invite('Ben','viewer'); await sleep(1050);
        a.messages.length=0;
        b.ws.send(JSON.stringify({type:'presence',p:{cursor:{x:99,y:0},preview:{kind:'move',ids:['Board'],dx:9},editing:{id:'Board',text:'private'}}}));
        await until(()=>a.messages.some(m=>m.type==='presence'));
        const v=a.messages.find(m=>m.type==='presence').peers[0];
        assert.equal(v.preview,undefined); assert.equal(v.editing,undefined); assert.equal(v.cursor.x,99); assert.equal(v.role,'viewer');
        b.ws.close(); await until(()=>a.messages.some(m=>m.type==='presence' && m.peers.some((p:any)=>p.gone)));
    } finally { for(const s of sockets)s.close(); await h.stop(); fs.rmSync(dir,{recursive:true,force:true}); }
});
