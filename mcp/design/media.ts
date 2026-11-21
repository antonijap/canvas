import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { request } from 'node:https';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { resolveDocPath } from '../../src/docpath.ts';

type Address = {address:string; family:number};
type Options = {home?:string; fetch?:(url:string, init?:RequestInit)=>Promise<Response>; lookup?:(host:string)=>Promise<Address[]>};
const blocked = new BlockList();
for(const [address,prefix] of [['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.168.0.0',16],['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3]] as const) blocked.addSubnet(address,prefix,'ipv4');
for(const [address,prefix] of [['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20]] as const) blocked.addSubnet(address,prefix,'ipv6');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::',3,'ipv6');
function publicAddress(address:string) {
  const family=isIP(address);
  return family===4 ? !blocked.check(address,'ipv4') : family===6 && globalV6.check(address,'ipv6') && !blocked.check(address,'ipv6');
}
async function addresses(url:URL, options:Options) {
  const host=url.hostname.replace(/^\[|\]$/g,'');
  const result=isIP(host)?[{address:host,family:isIP(host)}]:await (options.lookup ?? (host=>lookup(host,{all:true})))(host);
  if(!result.length || result.some(a=>!publicAddress(a.address))) throw new Error('Image hosts must resolve only to public IP addresses');
  return result;
}
// Pin the connection to a checked address while keeping the original host for TLS.
function pinnedFetch(url:URL, address:Address):Promise<Response> {
  return new Promise((resolve,reject)=>{
    const req=request(url,{family:address.family,lookup:(_host,_options,callback)=>callback(null,address.address,address.family),signal:AbortSignal.timeout(20_000)},res=>{
      const headers=new Headers();
      for(const [key,value] of Object.entries(res.headers)) if(value!==undefined) headers.set(key,Array.isArray(value)?value.join(', '):value);
      const body=[204,205,304].includes(res.statusCode!)?null:Readable.toWeb(res) as ReadableStream;
      if(!body) res.resume();
      resolve(new Response(body,{status:res.statusCode,headers}));
    });
    req.on('error',reject);req.end();
  });
}
const LIMIT = 20 * 1024 * 1024;
function https(source:string) {
  const url = new URL(source);
  if(url.protocol !== 'https:' || url.username || url.password) throw new Error('Image URLs must use https without credentials');
  return url;
}
async function download(source:string, options:Options, contentType='image/'):Promise<Buffer> {
  let url=https(source);
  for(let i=0;i<6;i++) {
    const approved=await addresses(url,options);
    const r=options.fetch ? await options.fetch(url.href,{redirect:'manual',signal:AbortSignal.timeout(20_000)}) : await pinnedFetch(url,approved[0]);
    if(r.status>=300 && r.status<400) {
      await r.body?.cancel();
      const location=r.headers.get('location');
      if(!location) throw new Error('Image redirect has no location');
      url=https(new URL(location,url).href);continue;
    }
    if(!r.ok) {await r.body?.cancel();throw new Error(`Image download failed (${r.status})`);}
    const mime=(r.headers.get('content-type') ?? '').toLowerCase().split(';')[0].trim();
    if(!(contentType==='image/' ? /^image\/[a-z0-9.+-]+$/.test(mime) : mime===contentType)) {await r.body?.cancel();throw new Error('Unexpected image download content type');}
    if(Number(r.headers.get('content-length'))>LIMIT) {await r.body?.cancel();throw new Error('Image exceeds 20 MB');}
    const chunks:Uint8Array[]=[];let size=0;
    if(!r.body) throw new Error('Image download was empty');
    for await(const chunk of r.body) {size+=chunk.length;if(size>LIMIT) {throw new Error('Image exceeds 20 MB');}chunks.push(chunk);}
    return Buffer.concat(chunks);
  }
  throw new Error('Too many image redirects');
}
function format(bytes:Buffer):string {
  if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'png';
  if(bytes[0]===255 && bytes[1]===216) return 'jpg';
  if(bytes.toString('ascii',0,3)==='GIF') return 'gif';
  if(bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') return 'webp';
  if(/<svg[\s>]/i.test(bytes.toString('utf8',0,1024))) {
    if(/<script|<foreignObject|\bon\w+\s*=|(?:href|url)\s*[=(]\s*["']?(?:https?:|file:|javascript:)/i.test(bytes.toString())) throw new Error('SVG must contain only self-contained image content');
    return 'svg';
  }
  throw new Error('Unsupported image: use PNG, JPEG, GIF, WebP or SVG');
}
async function save(file:string,bytes:Buffer) {
  const ext=format(bytes), name=createHash('sha256').update(bytes).digest('hex').slice(0,24)+'.'+ext;
  const docFile=resolveDocPath(file), dir=path.join(path.dirname(docFile),'media');
  await fs.mkdir(dir,{recursive:true});
  // Never follow an existing media symlink out of the document package.
  const base=await fs.realpath(path.dirname(docFile)), real=await fs.realpath(dir);
  if(real!==path.join(base,'media')) throw new Error('media must stay inside the file');
  const dest=path.join(dir,name);
  const entry=await fs.lstat(dest).catch(()=>null);
  if(entry?.isSymbolicLink()) throw new Error('media image must not be a symlink');
  await fs.writeFile(dest,bytes,{flag:'wx'}).catch((e)=>{if(e.code!=='EEXIST')throw e;});
  return {url:'media/'+name,bytes,ext};
}
export async function copyImage(file:string,source:string,options:Options={}) {
  let bytes:Buffer;
  if(/^[a-z][a-z\d+.-]*:/i.test(source)) bytes=await download(source,options);
  else {
    const home=path.resolve(options.home ?? os.homedir());
    const realHome=await fs.realpath(home);
    const requested=path.resolve(source.startsWith('~/')?path.join(home,source.slice(2)):source);
    if(!requested.startsWith(home+path.sep)) throw new Error('Local images must be inside the user home');
    const real=await fs.realpath(requested);
    if(!real.startsWith(realHome+path.sep)) throw new Error('Local images must be inside the user home');
    const stat=await fs.stat(real);
    if(!stat.isFile() || stat.size>LIMIT) throw new Error('Image must be a file of at most 20 MB');
    bytes=await fs.readFile(real);
  }
  return save(file,bytes);
}
function dimensions(bytes:Buffer, ext:string) {
  if(ext==='png') return {width:bytes.readUInt32BE(16),height:bytes.readUInt32BE(20)};
  if(ext==='svg') {
    const svg=bytes.toString(),tag=svg.match(/<svg\b[^>]*>/i)?.[0] ?? '';
    const width=Number(tag.match(/\bwidth=["']([\d.]+)/)?.[1]),height=Number(tag.match(/\bheight=["']([\d.]+)/)?.[1]);
    if(width && height) return {width,height};
    const v=tag.match(/viewBox=["']([^"']+)/)?.[1].trim().split(/[\s,]+/).map(Number);
    if(v?.length===4 && v[2]>0 && v[3]>0) return {width:v[2],height:v[3]};
  }
  throw new Error('Official badge has no readable aspect ratio');
}
export async function badgeImage(file:string,kind:'app-store-badge'|'google-play-badge',options:Options={}) {
  try {
    let url='https://tools.applemarketingtools.com/api/badges/download-on-the-app-store/black/en-us';
    if(kind==='google-play-badge') {
      const page='https://play.google.com/intl/en_us/badges/';
      const html=(await download(page,options,'text/html')).toString();
      const src=html.match(/(?:src|href)=["']([^"']*(?:en_badge_web_generic|google-play-badge)[^"']*\.png)["']/i)?.[1];
      if(src) url=new URL(src,page).href;
      else {
        const endpoint=html.slice(html.indexOf('id="badges"')).match(/data-asset-endpoint=["']([^"']+)/)?.[1];
        if(!endpoint) throw new Error('Official badge page did not provide its English badge image');
        const assetUrl=new URL(endpoint.replaceAll('&amp;','&'),'https://partnermarketinghub.withgoogle.com').href;
        const assets=JSON.parse((await download(assetUrl,options,'application/json')).toString()).assets;
        const asset=assets?.find((a:any)=>typeof a.url==='string' && /googleplay-badge-01-getit.*\.png/.test(a.url));
        if(!asset) throw new Error('Official badge page has no download badge image');
        url=asset.url;
      }
    }
    const bytes=await download(url,options),ext=format(bytes),size=dimensions(bytes,ext);
    const saved=await save(file,bytes);
    return {url:saved.url,...size,source:kind==='google-play-badge'?'https://play.google.com/intl/en_us/badges/':url};
  } catch(e) {throw new Error(`Cannot download official ${kind}; check the connection or retry when online: ${(e as Error).message}`);}
}
