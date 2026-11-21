import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { copyImage, badgeImage } from '../mcp/design/media.ts';
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
    const remote=await copyImage(file,'https://example.com/photo.svg',{fetch:async()=>new Response(svg)});
    assert.equal(remote.url,r.url);
    await assert.rejects(copyImage(file,'https://example.com/a',{fetch:async()=>new Response(null,{status:302,headers:{location:'http://example.com/a'}})}),/https/);
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('official badges fetch at insertion time, preserve aspect, and report offline clearly', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(),'design-badge-'));
  try {
    for(const kind of ['app-store-badge','google-play-badge'] as const) {
      const calls:string[]=[];
      const r=await badgeImage(path.join(dir,'Work.canvas'),kind,{fetch:async(url)=>{calls.push(String(url));return new Response(String(url).endsWith('/badges/')?'<img src="static/images/badges/en_badge_web_generic.png">':svg);}});
      assert.equal(r.width/r.height,3);
      assert.equal(calls.length,kind==='app-store-badge'?1:2);
      assert.match(calls[0],kind==='app-store-badge'?/applemarketingtools/:/play.google/);
      await assert.rejects(badgeImage(path.join(dir,'Work.canvas'),kind,{fetch:async()=>{throw new Error('network');}}),/offline|download/i);
    }
  } finally {await fs.rm(dir,{recursive:true,force:true});}
});
test('current official badge page resolves its asset endpoint', async()=>{
 const dir=await fs.mkdtemp(path.join(os.tmpdir(),'design-badge-'));
 try {
  const r=await badgeImage(path.join(dir,'Work.canvas'),'google-play-badge',{fetch:async url=>{
   if(url.endsWith('/badges/')) return new Response('<h2 id="badges">Badges</h2><div data-asset-endpoint="/brands/api/asset/?signature=fixture">');
   if(url.includes('/api/asset/')) return new Response(JSON.stringify({assets:[{url:'https://storage.googleapis.com/brand/googleplay-badge-01-getit.width-375.png'}]}));
   return new Response(svg);
  }});
  assert.equal(r.width/r.height,3);
 } finally {await fs.rm(dir,{recursive:true,force:true});}
});
