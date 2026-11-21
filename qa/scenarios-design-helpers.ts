import fs from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { sc, type T } from './harness.ts';
import { ROOT } from './lib.ts';

sc('design helpers','agent builds and repairs a feed', {covers:['design-helpers:recipe','design-helpers:checks','design-helpers:components'],skip:{visual:'Protocol scenario renders its own scratch board; the harness page is unchanged.'}}, async (t:T)=>{
  const file=path.join(path.dirname(t.file),'Helpers.canvas');
  fs.mkdirSync(file);fs.writeFileSync(path.join(file,'document.json'),JSON.stringify({version:'2.21',children:[]}));
  const client=new Client({name:'design-qa',version:'1'});
  try {
    await client.connect(new StdioClientTransport({command:process.execPath,args:[path.join(ROOT,'mcp/server.ts')],env:{...process.env,CANVAS_PORT:String(t.srv.port),CANVAS_MCP_BACKGROUND:'0',CANVAS_MCP_NO_SPAWN:'1'} as Record<string,string>,stderr:'pipe'}));
    const call=async(name:string,args:Record<string,unknown>={})=>{
      const r:any=await client.callTool({name,arguments:{file,...args}});
      t.ok(!r.isError,`${name}: ${r.content?.[0]?.text}`);
      return JSON.parse(r.content[0].text);
    };
    const recipe:any=await client.callTool({name:'get_recipe',arguments:{topic:'feed'}});
    t.ok(recipe.content[0].text.includes('## Taste'),'agent reads the feed recipe');
    t.ok(recipe.content[0].text.includes('set_variables'),'recipe explains how to create tokens');
    await call('set_variables',{variables:{surface:{light:'#FFFFFF',dark:'#111111'},ink:'#000000'}});
    const summary=await call('get_document_summary');
    t.ok(summary.variables.some((v:any)=>v.name==='surface' && v.type==='color'),'file lists the new colour variable');
    await call('add_nodes',{nodes:[{id:'feed',type:'frame',name:'Feed / Empty',width:393,height:852,layout:'none',fill:'$surface',children:[
      {id:'drawn-status',type:'frame',name:'Status bar',width:393,height:54,children:[{id:'drawn-time',type:'text',name:'Clock',content:'9:41',fontFamily:'SF Pro',fontSize:17,fontWeight:'600',width:54,height:22,x:54,y:19,fill:'#000000'}]},
      {id:'top',type:'frame',name:'Top bar',y:59,width:393,height:48,fill:'$surface',children:[{id:'home-icon',type:'icon',name:'Home icon',library:'lucide',icon:'house',width:24,height:24,fill:'$ink'}]},
      {id:'empty',type:'frame',name:'Empty state',x:46.5,y:180,width:300,height:150,children:[{id:'title',type:'text',name:'Empty headline',content:'A quiet moment',fontSize:20,fontFamily:'SF Pro',fontWeight:'600',width:300,height:24,textAlign:'center',fill:'#000000'}]},
      {id:'tabs',type:'frame',name:'Tab bar',x:0,y:769,width:393,height:83,layout:'horizontal',children:['Home active','Search','Profile'].map((name,i)=>({id:'tab'+i,type:'frame',name,width:'fill_container',height:49,children:[{id:'label'+i,type:'text',name:'Tab label',content:name,fontFamily:'SF Pro',fontSize:10,fontWeight:'400',width:70,height:12,fill:'#000000'}]}))},
    ]}]});
    const before=await call('check_design',{boards:['feed']});
    for(const rule of ['R-7-50','R-7-4','R-7-26']) t.ok(before.issues.some((i:any)=>i.rule===rule),`reports ${rule}`);
    t.ok(!before.issues.some((i:any)=>i.rule==='R-7-18'),'toolbar icon keeps regular sizing on the empty feed');
    await call('delete_nodes',{ids:['drawn-status']});
    const inserted=await call('insert_component',{kind:'ios-status-bar',parent:'feed'});
    t.ok(inserted.registered,'first call registers component');
    const after=await call('check_design',{boards:['feed']});
    t.ok(!after.issues.some((i:any)=>i.rule==='R-7-50'),'official status bar fixes status issue');
    for(const rule of ['R-7-4','R-7-26']) t.ok(after.issues.some((i:any)=>i.rule===rule),`still reports ${rule}`);
    const second=await call('insert_component',{kind:'ios-status-bar',x:500,y:1100});
    t.eq(second.componentId,inserted.componentId,'later insertion reuses main');
    t.eq(second.registered,false,'main registered only once');
    const finished=await call('finish_work',{summary:'Built feed'});
    t.ok(finished.warnings.some((i:any)=>i.rule==='R-7-4'),'finish appends warnings without blocking');
    const render:any=await client.callTool({name:'render_node',arguments:{file,id:'feed'}});
    t.ok(!render.isError && render.content.some((c:any)=>c.type==='image'),'board renders headlessly');
    const img=render.content.find((c:any)=>c.type==='image');
    if(img) fs.writeFileSync(path.join(path.dirname(t.file),'design-helpers.png'),Buffer.from(img.data,'base64'));
  } finally {await client.close();}
});
