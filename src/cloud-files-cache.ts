// Disposable objects are content addressed; SQLite remains the commit point for a file and its pending edits.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {gzipSync,gunzipSync} from 'node:zlib';
import type {DocNode} from '../cloud/protocol-files.ts';
export function writeBoardCheckpoint(dir:string,children:DocNode[]):{id:string;sha256:string}[]{
 fs.mkdirSync(dir,{recursive:true,mode:0o700});if(fs.lstatSync(dir).isSymbolicLink())throw new Error('Board cache is a link');
 return children.map(node=>{
  const text=JSON.stringify(node),sha256=createHash('sha256').update(text).digest('hex'),dest=path.join(dir,sha256+'.json.gz');
  if(fs.existsSync(dest)){
   try{if(fs.lstatSync(dest).isSymbolicLink()||createHash('sha256').update(gunzipSync(fs.readFileSync(dest),{maxOutputLength:32*1024*1024})).digest('hex')!==sha256)throw new Error('hash');}
   catch{throw Object.assign(new Error('Invalid board cache hash'),{corruptFile:dest});}
  }else{
   const tmp=path.join(dir,'.board-'+randomUUID()),fd=fs.openSync(tmp,'wx',0o600);
   try{fs.writeFileSync(fd,gzipSync(text));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
   try{fs.linkSync(tmp,dest);}catch(e){if((e as NodeJS.ErrnoException).code!=='EEXIST')throw e;}finally{fs.unlinkSync(tmp);}
  }
  return {id:String(node.id),sha256};
 });
}
function bytes(dir:string):number{return fs.readdirSync(dir,{withFileTypes:true}).reduce((n,e)=>{const p=path.join(dir,e.name);return n+(e.isSymbolicLink()?0:e.isDirectory()?bytes(p):fs.statSync(p).size);},0);}
export function evictClosedPackages(root:string,open:Set<string>,cap=5*1024**3):string[]{
 if(!fs.existsSync(root))return[];const files:{pkg:string;bytes:number;at:number;pending:boolean}[]=[];
 for(const c of fs.readdirSync(root,{withFileTypes:true})){
  if(!c.isDirectory()||!/^[0-9a-f]{16}$/.test(c.name))continue;const cloud=path.join(root,c.name);
  for(const f of fs.readdirSync(cloud,{withFileTypes:true})){
   if(!f.isDirectory()||!/^[0-9a-f-]{36}\.canvas$/.test(f.name))continue;const pkg=path.join(cloud,f.name),file=path.join(pkg,'.cloud','state.sqlite');let pending=true;
   if(!open.has(pkg)&&fs.existsSync(file)){let db:DatabaseSync|undefined;try{db=new DatabaseSync(file,{readOnly:true});pending=Number(db.prepare('SELECT COUNT(*) AS n FROM pending').get()!.n)>0;const have=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='comments_state'").get();if(have){const c=db.prepare('SELECT json FROM comments_state WHERE id=1').get();if(c)pending ||= JSON.parse(String(c.json)).commentsPending?.length>0;}}catch{pending=true;}finally{db?.close();}}
   files.push({pkg,bytes:bytes(pkg),at:fs.statSync(pkg).mtimeMs,pending:pending||open.has(pkg)});
  }
 }
 let total=files.reduce((n,f)=>n+f.bytes,0);const removed:string[]=[];
 for(const f of files.sort((a,b)=>a.at-b.at)){if(total<=cap)break;if(f.pending)continue;fs.rmSync(f.pkg,{recursive:true,force:true});total-=f.bytes;removed.push(f.pkg);}return removed;
}
