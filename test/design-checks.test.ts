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
