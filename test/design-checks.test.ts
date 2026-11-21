import assert from 'node:assert/strict';
import { test } from 'node:test';
import { checkDesign } from '../mcp/design/checks.ts';
import { statusBar, type Node } from '../mcp/design/components.ts';
let serial=0;
const node=(props:Node={}):Node=>({id:'subject'+serial++,type:'rectangle',name:'Content',width:100,height:40,fill:'$text',...props});
const doc=(children:Node[])=>({version:'2.21',children,variables:{text:{type:'color',value:'#000000'}}});
function has(rule:string,children:Node[]) {return checkDesign(doc(children)).some(i=>i.rule===rule);}
const board=(children:Node[],extra:Node={})=>node({id:'board',type:'frame',name:'Feed',width:393,height:852,children,...extra});
const icon=(id:string,size=24)=>node({id,type:'icon',name:'Home icon',library:'lucide',icon:'house',width:size,height:size});

test('R-7-4 tab slots, selection and bottom edge',()=>{
 const tabs=node({type:'frame',name:'Tab bar',y:769,width:393,height:83,children:['Home active','Search','Profile'].map((name,i)=>node({id:'slot'+i,type:'frame',name,width:'fill_container',children:[icon('icon'+i),node({id:'label'+i,type:'text',name:'Label',content:name})]}))});
 assert.equal(has('R-7-4',[board([tabs])]),false);
 for(const change of [(n:Node)=>n.children[1].children.shift(),(n:Node)=>n.y--,(n:Node)=>n.children[0].name='Home', (n:Node)=>{n.stroke='$text';n.strokeWidth=1;}]) {const bad=structuredClone(tabs);change(bad);assert.equal(has('R-7-4',[board([bad])]),true);}
});
test('R-7-50 rejects hand-drawn bars and accepts reusable system instance',()=>{
 const main:Node={...statusBar(),reusable:true};
 const inst={id:'status',type:'ref',name:'iOS status bar',ref:main.id,x:0,y:0};
 assert.equal(has('R-7-50',[main,board([inst])]),false);
 assert.equal(has('R-7-50',[board([node({name:'Status bar',width:393,height:59})])]),true);
});
test('R-7-26 empty state centres in free space',()=>{
 const header=node({name:'Top bar',height:100,width:393});
 const empty=node({name:'Empty state',x:46.5,y:334.5,width:300,height:200});
 const tabs=node({name:'Tab bar',y:769,width:393,height:83});
 assert.equal(has('R-7-26',[board([header,empty,tabs])]),false);
 assert.equal(has('R-7-26',[board([header,{...empty,y:150},tabs])]),true);
});
test('R-7-11 checks fill, stroke and effect colours',()=>{
 assert.equal(has('R-7-11',[node({fill:'$text',stroke:{fill:'$text'},effect:[{color:'$text'}]})]),false);
 for(const props of [{fill:'#FFFFFF'},{stroke:{fill:'#FFFFFF'}},{effect:[{color:'#FFFFFF'}]}]) assert.equal(has('R-7-11',[node(props)]),true);
});
test('R-7-24 detects default names and generated suffixes',()=>{
 assert.equal(has('R-7-24',[node()]),false);
 for(const name of ['Frame 2','rectangle','body_text-12']) assert.equal(has('R-7-24',[node({name})]),true);
});
test('R-7-18 checks row sizes and file library',()=>{
 const row=node({type:'frame',name:'Actions',layout:'horizontal',children:[icon('a'),icon('b')]});
 assert.equal(has('R-7-18',[row]),false);
 assert.equal(has('R-7-18',[{...row,children:[icon('a'),icon('b',20)]}]),true);
 assert.equal(has('R-7-18',[{...row,children:[icon('a'),{...icon('b'),library:'feather'}]}]),true);
 assert.equal(has('R-7-18',[icon('bad',30)]),true);
});
test('R-7-33 text height respects lines',()=>{
 const text=node({type:'text',content:'Read this',fontSize:20,lineHeight:1.2,height:24});
 assert.equal(has('R-7-33',[text]),false);
 assert.equal(has('R-7-33',[{...text,height:20}]),true);
 assert.equal(has('R-7-33',[{...text,content:'Read\nthis',height:24}]),true);
});
test('R-7-18 uses only ancestor frames below the board for empty-state sizes',()=>{
 const state=node({type:'frame',name:'Empty state',children:[icon('illustration',40),icon('small-state',24)]});
 const group=node({type:'group',name:'Error group',children:[icon('group-icon')]});
 const root=board([{...icon('toolbar'),name:'Empty inbox icon'},state,group,icon('large-toolbar',40)],{name:'Feed / Empty'});
 assert.deepEqual(checkDesign(doc([root])).filter(i=>i.rule==='R-7-18').map(i=>i.nodeId),['small-state','large-toolbar']);
});
test('screen checks skip library boards and reusable mains while general checks still apply',()=>{
 const children=[
  node({name:'Tab bar',y:400}),
  node({name:'Empty state',y:80}),
  node({name:'Top button',y:10}),
  node({name:'Bottom link',y:830}),
  node({name:'Rectangle',fill:'#123456'}),
  icon('oversized',80),
 ];
 const rules=['R-7-4','R-7-26','R-7-50','R-7-2'];
 const check=(root:Node)=>checkDesign(doc([root]));
 for(const props of [{name:'Design system'},{name:'Components / buttons'},{name:'Tokens'},{reusable:true}]) {
  const library=check(board(children,props));
  assert.deepEqual(library.filter(i=>rules.includes(i.rule)),[],JSON.stringify(props));
  for(const rule of ['R-7-11','R-7-24','R-7-18']) assert.equal(library.some(i=>i.rule===rule),true,rule);
 }
 const screen=check(board(children));
 for(const rule of rules) assert.equal(screen.some(i=>i.rule===rule),true,rule);
 assert.deepEqual(screen.filter(i=>i.rule==='R-7-2').map(i=>i.nodeId),[children[2].id,children[3].id]);
 const main=board(children,{id:'main',name:'Samples',reusable:true});
 const nested=check(board([main]));
 assert.deepEqual(nested.filter(i=>rules.includes(i.rule) && i.nodeId!=='board'),[]);
 assert.ok(nested.some(i=>i.rule==='R-7-24' && i.nodeId===children[4].id));
});
test('R-7-2 uses board-relative safe bands and exempts status and tab bar controls',()=>{
 const root=board([
  node({name:'Status bar',type:'frame',children:[node({name:'Status button'})]}),
  node({name:'Tab bar',type:'frame',y:729,height:83,children:[node({name:'Home tab',y:60,height:20})]}),
  node({name:'Header button',y:44}),
  node({name:'Footer link',y:738}),
 ],{x:800,y:900,width:375,height:812});
 assert.deepEqual(checkDesign(doc([root])).filter(i=>i.rule==='R-7-2'),[]);
});
test('R-7-42 hidden, empty and outside layers',()=>{
 assert.equal(has('R-7-42',[board([node()])]),false);
 for(const props of [{enabled:false},{opacity:0},{x:400},{type:'frame',fill:undefined,children:[]}]) assert.equal(has('R-7-42',[board([node(props)])]),true);
});
test('R-7-51 official image badges and centred mobile copy',()=>{
 const badge=node({name:'App store badge',fill:{type:'image',url:'media/badge.svg',mode:'fill'},metadata:{officialBadge:'app-store-badge'}});
 const hero=node({type:'frame',name:'Hero',children:[node({type:'text',name:'Headline',content:'Take a moment',textAlign:'center'})]});
 const web=board([badge,hero],{name:'Website'});
 assert.equal(has('R-7-51',[web]),false);
 assert.equal(has('R-7-51',[{...web,children:[{...badge,fill:'$text'},hero]}]),true);
 const bad=structuredClone(web);bad.children[1].children[0].textAlign='left';assert.equal(has('R-7-51',[bad]),true);
});
test('Canvas overlap includes board labels and respects pages',()=>{
 const a=board([],{x:0,y:0}),b=board([],{id:'second',x:410,y:0});
 assert.equal(has('canvas-overlap',[a,b]),false);
 assert.equal(has('canvas-overlap',[a,{...b,x:390}]),true);
 assert.equal(has('canvas-overlap',[a,{...b,x:0,y:860}]),true);
 assert.equal(has('canvas-overlap',[a,{...b,x:0,page:'other'}]),false);
});
test('rendered boxes are parent-relative; board positions stay in document coordinates',()=>{
 const root=board([node({id:'body',x:20,y:10,width:100,height:20})],{x:1000,y:2000});
 const measured={board:{x:0,y:0,width:393,height:852},body:{x:20,y:10,width:100,height:20}};
 assert.equal(checkDesign(doc([root]),undefined,measured).some(i=>i.rule==='R-7-42'),false);
});

test('R-7-18 permits selected tab colours and compares only sibling icon slots',()=>{
 const slots=[node({name:'Home active',children:[icon('home')]}),node({name:'Search',children:[{...icon('search'),fill:'$text-2'}]})];
 const row=node({name:'Tab row',layout:'horizontal',children:slots});
 assert.equal(has('R-7-18',[row]),false);
 const nested=node({name:'Actions',layout:'horizontal',children:[row,node({name:'Other row',layout:'horizontal',children:[icon('small',20)]})]});
 assert.equal(has('R-7-18',[nested]),false);
 slots[1].children[0].width=20;slots[1].children[0].height=20;
 assert.equal(has('R-7-18',[row]),true);
});
test('R-7-11 exempts only descendants of the reusable system status bar',()=>{
 const main:Node={...statusBar(),reusable:true};
 const instance={id:'status',type:'ref',ref:main.id};
 assert.equal(has('R-7-11',[main,board([instance])]),false);
 assert.equal(has('R-7-11',[main,board([instance,node({fill:'#123456'})])]),true);
 assert.equal(has('R-7-11',[board([node({name:'Status bar',children:[node({fill:'#123456'})]})])]),true);
});
test('R-7-18 keeps nested horizontal rows independent',()=>{
 const rows=[24,20].map((size,i)=>node({name:'Toolbar row',layout:'horizontal',children:[icon('nested'+i,size)]}));
 assert.equal(has('R-7-18',[node({name:'Actions',layout:'horizontal',children:rows})]),false);
});
test('R-7-11 exempts the status bar main nested in the component board',()=>{
 const main:Node={...statusBar(),reusable:true};
 assert.equal(has('R-7-11',[node({type:'frame',name:'Design system',children:[main]})]),false);
});
