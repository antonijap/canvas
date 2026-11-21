import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { buildIndex, expand, loadDoc, layoutBoxes } from '../../src/engine.ts';
import { api, ensureServer, resolveFile, ToolError } from '../client.ts';
import { tool } from '../tool.ts';
import * as S from '../schemas.ts';
import { getRecipe, topics } from '../recipe/index.ts';
import { componentPlan, id, statusBar, walk, type Node } from '../design/components.ts';
import { copyImage, badgeImage } from '../design/media.ts';
import { checkDesign } from '../design/checks.ts';

async function snapshot(file:string) {
  await api('POST','/api/flush',{file},{timeoutMs:30_000});
  return loadDoc(file);
}
export async function designIssues(file?:string,boards?:string[]) {
  await ensureServer();
  const f=await resolveFile(file), loaded=await snapshot(f), doc=loaded.doc;
  const roots=doc.children.map(n=>expand(buildIndex(doc),n));
  const boxes=layoutBoxes(roots,{doc,file:loaded.path});
  const pageList=await api<any>('GET','/api/pages?file='+encodeURIComponent(f));
  const pages:Record<string,string>={};
  for(const p of pageList.pages ?? []) for(const b of p.boards ?? []) pages[b]=p.id;
  return checkDesign(doc,boards,boxes,pages);
}
async function add(file:string,nodes:Node[],parent?:string) {
  return api<any>('POST','/api/structure',{file,op:'add',nodes,place:{parent:parent ?? null}});
}
export async function insertComponent(a:Node) {
  await ensureServer();
  const file=await resolveFile(a.file),loaded=await snapshot(file),doc=loaded.doc;
  if(!a.parent && (a.x===undefined || a.y===undefined)) throw new ToolError('invalid','Pass parent or both x and y');
  if(a.parent && !walk(doc.children).some(n=>n.id===a.parent && ['frame','group'].includes(n.type))) throw new ToolError('invalid','parent must be a frame or group');
  let template:Node;
  if(a.kind==='ios-status-bar') {
    if(a.width!==undefined && ![375,393].includes(a.width)) throw new ToolError('invalid','Status bar width must be 375 or 393');
    template=statusBar(a.width ?? 393,a.theme ?? 'light');
  } else {
    const badge=await badgeImage(file,a.kind);
    template={id:id(),type:'rectangle',name:a.kind==='app-store-badge'?'App store badge':'Google play badge',width:badge.width,height:badge.height,fill:{type:'image',url:badge.url,mode:'fill'},metadata:{designHelper:a.kind,officialBadge:a.kind,source:badge.source}};
  }
  const plan=componentPlan(doc,template,{x:a.x ?? 0,y:a.y ?? 0});
  if(plan.main) {
    const holder=doc.children.find(n=>/^(design system|components)$/i.test(String(n.name)) && n.type==='frame');
    if(holder) await add(file,[plan.main],holder.id);
    else await add(file,[{id:id(),type:'frame',name:'Design system',width:900,height:'fit_content',layout:'vertical',gap:24,padding:24,children:[plan.main]}]);
  }
  const r=await add(file,[plan.instance],a.parent);
  return {id:r.select[0],componentId:plan.instance.ref,registered:!!plan.main,revision:r.revision};
}
export async function addImage(a:Node) {
  await ensureServer();
  const file=await resolveFile(a.file);
  if(a.nodeId && ['x','y','width','height'].some(k=>a[k]!==undefined)) throw new ToolError('invalid','Use nodeId or x, y, width and height');
  if(a.nodeId) {
    const loaded=await snapshot(file),n=walk(loaded.doc.children).find(n=>n.id===a.nodeId);
    if(!n || !['frame','rectangle'].includes(n.type)) throw new ToolError('invalid','nodeId must name an existing frame or rectangle');
  } else if(!['x','y','width','height'].every(k=>typeof a[k]==='number' && Number.isFinite(a[k])) || a.width<=0 || a.height<=0) throw new ToolError('invalid','New images need x, y, positive width and height');
  const media=await copyImage(file,a.source),fill={type:'image',url:media.url,mode:'fill'};
  if(a.nodeId) {
    const r=await api<any>('POST','/api/update',{file,id:a.nodeId,props:{fill}});
    return {id:a.nodeId,fill,revision:r.revision};
  }
  const r=await add(file,[{id:id(),type:'rectangle',name:'Photo',x:a.x,y:a.y,width:a.width,height:a.height,fill}]);
  return {id:r.select[0],fill,revision:r.revision};
}
export function register(server:McpServer) {
  tool(server,'get_recipe','Before designing screens, read the recipe for the screen type and follow it. Includes Taste, the topic recipe, its rule IDs and their mechanical checks. Default all. Read-only; requires no open Canvas or server.',{topic:z.enum(topics).optional()},a=>getRecipe(a.topic),{readOnlyHint:true});
  tool(server,'insert_component','Insert a ready component as real layers and a reusable main in Design system. Every placement is an instance; later calls reuse the main. Status bars support width 393 or 375 and light/dark ink. Store badges download official artwork at insert time and require an internet connection.',{
    file:S.file,kind:z.enum(['ios-status-bar','app-store-badge','google-play-badge']),parent:z.string().optional(),x:z.number().optional(),y:z.number().optional(),width:z.union([z.literal(393),z.literal(375)]).optional(),theme:z.enum(['light','dark']).optional(),
  },insertComponent);
  tool(server,'add_image','Copy a local image inside the user home or an https image into file media. Fill an existing frame/rectangle with nodeId, or create a rectangle using x, y, width, height. Local paths and symlinks outside home and non-https URLs are refused.',{
    file:S.file,source:z.string().min(1),nodeId:z.string().optional(),x:z.number().optional(),y:z.number().optional(),width:z.number().positive().optional(),height:z.number().positive().optional(),
  },addImage);
  tool(server,'check_design','Read-only mechanical design checks and Canvas facts: tabs, status bar, empty-state centring, colour tokens, layer names, row icons, clipped text, hidden/outside layers, official badges, mobile text alignment and board/label overlap. Returns issues with rule, nodeId and message. Other recipe checks require visual review.',{
    file:S.file,boards:z.array(z.string()).optional(),
  },async a=>({issues:await designIssues(a.file,a.boards)}),{readOnlyHint:true});
}
