import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyImage, badgeImage } from '../mcp/design/media.ts';
const publicLookup=async()=>[{address:'93.184.216.34',family:4}];
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40"/></svg>';

test('image copies local and https sources, rejects paths escaping home and insecure URLs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'design-media-'));
  try {
    const home = path.join(dir,'home'), file=path.join(dir,'Work.canvas');
    await fs.mkdir(home); await fs.mkdir(file);
    const source=path.join(home,'photo.svg'); await fs.writeFile(source,svg);
    const r=await copyImage(file,source,{home});
    assert.equal(await fs.readFile(path.join(file,r.url),'utf8'),svg);
    await assert.rejects(copyImage(file,path.join(dir,'outside.svg'),{home}),/home/);
    await fs.writeFile(path.join(dir,'outside.svg'),svg);
    await fs.symlink(dir,path.join(home,'escape'));
    await assert.rejects(copyImage(file,path.join(home,'escape','outside.svg'),{home}),/home/);
    for(const source of ['http://example.com/a.png','file:///etc/hosts','ftp://example.com/a']) await assert.rejects(copyImage(file,source,{home}),/https/);
    const remote=await copyImage(file,'https://example.com/photo.svg',{lookup:publicLookup,fetch:async()=>new Response(svg,{headers:{'content-type':'image/svg+xml'}})});
    assert.equal(remote.url,r.url);
    await assert.rejects(copyImage(file,'https://example.com/a',{lookup:publicLookup,fetch:async()=>new Response(null,{status:302,headers:{location:'http://example.com/a'}})}),/https/);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('official badges fetch at insertion time, preserve aspect, and report offline clearly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'design-badge-'));
  try {
    for(const kind of ['app-store-badge','google-play-badge'] as const) {
      const calls:string[]=[];
      const r=await badgeImage(path.join(dir,'Work.canvas'),kind,{lookup:publicLookup,fetch:async(url)=>{calls.push(String(url));return new Response(String(url).endsWith('/badges/')?'<img src="static/images/badges/en_badge_web_generic.png">':svg,{headers:{'content-type':url.endsWith('/badges/')?'text/html':'image/svg+xml'}});}});
      assert.equal(r.width/r.height,3);
      assert.equal(calls.length,kind==='app-store-badge'?1:2);
      if(kind==='app-store-badge') assert.equal(calls[0],'https://toolbox.marketingtools.apple.com/api/v2/badges/download-on-the-app-store/black/en-us');
      else assert.match(calls[0],/play\.google/);
      await assert.rejects(badgeImage(path.join(dir,'Work.canvas'),kind,{lookup:publicLookup,fetch:async()=>{throw new Error('network');}}),/offline|download/i);
    }
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('current official badge page resolves its asset endpoint', async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'design-badge-'));
 try {
  const r=await badgeImage(path.join(dir,'Work.canvas'),'google-play-badge',{lookup:publicLookup,fetch:async url=>{
   if(url.endsWith('/badges/')) return new Response('<h2 id="badges">Badges</h2><div data-asset-endpoint="/brands/api/asset/?signature=fixture">',{headers:{'content-type':'text/html'}});
   if(url.includes('/api/asset/')) return new Response(JSON.stringify({assets:[{url:'https://storage.googleapis.com/brand/googleplay-badge-01-getit.width-375.png'}]}),{headers:{'content-type':'application/json'}});
   return new Response(svg,{headers:{'content-type':'image/svg+xml'}});
  }});
  assert.equal(r.width/r.height,3);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});

test('remote images refuse private addresses before fetching, including DNS and redirects', async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'design-private-'));
 try {
  for(const host of ['127.0.0.1','10.1.2.3','172.16.0.1','192.168.0.1','169.254.169.254','0.0.0.0','[::1]','[fc00::1]','[fe80::1]','[::ffff:127.0.0.1]']) {
   let called=false;
   await assert.rejects(copyImage(dir,'https://'+host+'/image',{lookup:publicLookup,fetch:async()=>{called=true;return new Response(svg,{headers:{'content-type':'image/svg+xml'}});}}),/public|private/i);
   assert.equal(called,false);
  }
  for(const address of ['127.0.0.1','::1','169.254.169.254']) {
   await assert.rejects(copyImage(dir,'https://image.example/a',{lookup:async()=>[{address,family:address.includes(':')?6:4}],fetch:async()=>new Response(svg,{headers:{'content-type':'image/svg+xml'}})}),/public|private/i);
  }
  await assert.rejects(copyImage(dir,'https://image.example/a',{lookup:async()=>[{address:'93.184.216.34',family:4}],fetch:async()=>new Response(null,{status:302,headers:{location:'https://127.0.0.1/a'}})}),/public|private/i);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('remote images require image content type and enforce declared and streamed limits', async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'design-limit-'));
 const lookup=async()=>[{address:'93.184.216.34',family:4}];
 try {
  for(const headers of [{},{'content-type':'text/html'},{'content-type':'image/svg+xml','content-length':String(20*1024*1024+1)}] as Record<string,string>[]) {
   await assert.rejects(copyImage(dir,'https://image.example/a',{lookup,fetch:async()=>new Response(svg,{headers})}),/content type|20 MB/i);
  }
  await assert.rejects(copyImage(dir,'https://image.example/a',{lookup,fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(20*1024*1024+1));c.close();}}),{headers:{'content-type':'image/png'}})}),/20 MB/);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
