import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { register, addImage, insertComponent } from '../mcp/tools/design.ts';
import { walk } from '../mcp/design/components.ts';

test('get_recipe works offline in background mode without Canvas or an HTTP request',async()=>{
 const previous=globalThis.fetch,bg=process.env.CANVAS_MCP_BACKGROUND;
 process.env.CANVAS_MCP_BACKGROUND='1';
 globalThis.fetch=async()=>{throw new Error('No server should be contacted');};
 try {
  const tools=new Map<string,any>();
  register({registerTool(name:string,config:any,cb:any){tools.set(name,{config,cb});}} as any);
  const r=await tools.get('get_recipe').cb({topic:'permission'},{});
  assert.equal(r.isError,undefined);assert.match(r.content[0].text,/Permission ask/);
  assert.equal(tools.get('get_recipe').config.annotations.readOnlyHint,true);
  assert.equal(tools.get('check_design').config.annotations.readOnlyHint,true);
 } finally {globalThis.fetch=previous;if(bg===undefined)delete process.env.CANVAS_MCP_BACKGROUND;else process.env.CANVAS_MCP_BACKGROUND=bg;}
});

test('image tool creates rectangles, fills existing frames, refuses invalid targets; insertion reuses main',async()=>{
 const dir=fs.mkdtempSync(path.join(process.cwd(),'.design-tool-test-'));
 const previous=globalThis.fetch,bg=process.env.CANVAS_MCP_BACKGROUND;
 process.env.CANVAS_MCP_BACKGROUND='1';
 const file=path.join(dir,'Work.canvas');fs.mkdirSync(file);
 const docPath=path.join(file,'document.json');
 let doc:any={version:'2.21',children:[{id:'screen',type:'frame',name:'Feed',width:393,height:852,children:[]}]};
 const persist=()=>fs.writeFileSync(docPath,JSON.stringify(doc));persist();
 const svg='<svg width="120" height="40"><rect width="120" height="40"/></svg>';
 const source=path.join(dir,'photo.svg');fs.writeFileSync(source,svg);
 globalThis.fetch=(async(input:any,init:any)=>{
  const url=new URL(input);
  if(url.hostname==='example.com')return new Response(svg);
  let result:any={};
  if(url.pathname==='/health')result={ok:true,headless:true,version:'test'};
  if(url.pathname==='/api/structure') {
   const body=JSON.parse(init.body),parent=body.place.parent?walk(doc.children).find(n=>n.id===body.place.parent):doc;
   parent.children??=[];parent.children.push(...body.nodes);persist();result={select:body.nodes.map((n:any)=>n.id),revision:'test'};
  }
  if(url.pathname==='/api/update') {
   const body=JSON.parse(init.body);Object.assign(walk(doc.children).find(n=>n.id===body.id)!,body.props);persist();result={revision:'test'};
  }
  return new Response(JSON.stringify(result));
 }) as typeof fetch;
 try {
  const newImage=await addImage({file,source,x:500,y:0,width:120,height:40});
  const created=walk(doc.children).find(n=>n.id===newImage.id)!;
  assert.equal(created.type,'rectangle');assert.equal(created.fill.mode,'fill');assert.equal(created.width,120);
  const fill=await addImage({file,source:'https://example.com/photo.svg',nodeId:'screen'});
  assert.equal(fill.fill.url,newImage.fill.url);assert.equal(doc.children[0].fill.mode,'fill');
  await assert.rejects(addImage({file,source,nodeId:'missing'}),/existing frame/);
  await assert.rejects(addImage({file,source,nodeId:'screen',x:2}),/nodeId or/);
  await assert.rejects(addImage({file,source,x:0,y:0,width:0,height:1}),/positive/);
  const first=await insertComponent({file,kind:'ios-status-bar',parent:'screen'});
  const second=await insertComponent({file,kind:'ios-status-bar',parent:'screen'});
  assert.equal(first.registered,true);assert.equal(second.registered,false);
  assert.equal(first.componentId,second.componentId);
  const main=walk(doc.children).find(n=>n.id===first.componentId)!;
  assert.equal(main.reusable,true);assert.equal(main.children.length,5);
  assert.equal(walk(doc.children).find(n=>n.id===second.id)!.type,'ref');
 } finally {globalThis.fetch=previous;if(bg===undefined)delete process.env.CANVAS_MCP_BACKGROUND;else process.env.CANVAS_MCP_BACKGROUND=bg;fs.rmSync(dir,{recursive:true,force:true});}
});
