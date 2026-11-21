import { buildIndex, expand, defaultTheme, resolveVariable } from '../../src/doc/resolve.ts';
import { walk, type Node } from './components.ts';
export type Issue = {rule:string;nodeId:string;message:string};
export type Box = {x:number;y:number;width:number;height:number;problems?:string};

export function checkDesign(doc:Node, boards?:string[], measured:Record<string,Box>={}, pages:Record<string,string>={}):Issue[] {
  const issues:Issue[]=[];
  const index=buildIndex(doc as any), theme=defaultTheme(doc as any);
  const num=(v:any):number=>Number(typeof v==='string' && v.startsWith('$')?resolveVariable(doc as any,v.slice(1),theme):v) || 0;
  const roots=(doc.children ?? []).map((n:Node)=>expand(index,n as any) as Node);
  const boxes:Record<string,Box>={};
  const locate=(n:Node,p?:Box)=>{
    const m=measured[n.id];
    const b=m ? {...m,x:p?p.x+m.x:num(n.x),y:p?p.y+m.y:num(n.y)} : {x:(p?.x ?? 0)+num(n.x),y:(p?.y ?? 0)+num(n.y),width:num(n.width),height:num(n.height)};
    boxes[n.id]=b;(n.children ?? []).forEach((c:Node)=>locate(c,b));
  };
  roots.forEach((n:Node)=>locate(n));
  const add=(rule:string,n:Node,message:string)=>{if(!issues.some(i=>i.rule===rule && i.nodeId===n.id && i.message===message)) issues.push({rule,nodeId:String(n.id),message});};
  const name=(n:Node)=>String(n.name ?? '');
  const all=walk(roots), libraries=new Set(all.filter(n=>n.type==='icon').map(n=>n.library));
  const image=(n:Node)=>[n.fill].flat().some(f=>f?.type==='image');
  const hasRaw=(v:any):boolean=> typeof v==='string' ? /^#|^rgba?\(|^hsla?\(/i.test(v) : Array.isArray(v)?v.some(hasRaw):v && typeof v==='object'?Object.entries(v).some(([k,x])=>['color','fill','stroke','stops','colors'].includes(k)&&hasRaw(x)):false;
  const overlaps=(a:Box,b:Box)=>a.x<b.x+b.width && a.x+a.width>b.x && a.y<b.y+b.height && a.y+a.height>b.y;
  const mainIds=new Set(walk(doc.children ?? []).filter(n=>n.reusable && n.metadata?.designHelper?.startsWith('ios-status-bar:')).map(n=>n.id));
  for(const root of roots) {
    if(boards && !boards.includes(root.id)) continue;
    if(root.reusable) continue;
    const rb=boxes[root.id], nodes=walk([root]);
    const systemLayers=new Set(nodes.filter(n=>mainIds.has(n.id) || mainIds.has(n.__ref)).flatMap(n=>walk([n]).map(c=>c.id)));
    const tab=nodes.find(n=>/tab bar/i.test(name(n)));
    const phone=(rb.width===393 && rb.height===852 || rb.width===375 && rb.height===812) && !/website|landing/i.test(name(root));
    if(phone) {
      const bar=nodes.find(n=>/status bar/i.test(name(n)));
      const time=bar && walk([bar]).find(n=>n.type==='text' && n.content==='9:41');
      if(!bar || boxes[bar.id].y!==rb.y || boxes[bar.id].width!==rb.width || boxes[bar.id].height!==(rb.width===375?44:54) || !time || num(time.fontSize)!==17 || num(time.fontWeight)!==600 || !mainIds.has(bar.__ref)) add('R-7-50',bar ?? root,'Use insert_component ios-status-bar at the top edge, at the board width.');
    }
    for(const n of nodes) {
      const b=boxes[n.id], children=n.children ?? [], descendants=walk(children);
      if(/^(frame|group|rectangle|ellipse|text|vector|line|image|copy)( \d+)?$/i.test(name(n)) || /_(text|rect|icon|frame)-\d+$/i.test(name(n))) add('R-7-24',n,'Give the layer a name describing its role.');
      if(!name(n).trim()) add('R-7-24',n,'Name the layer by its role.');
      if(!systemLayers.has(n.id) && !image(n) && [n.fill,n.stroke,n.effect].some(hasRaw)) add('R-7-11',n,'Bind fill, stroke and effect colours to $variables.');
      if(n.enabled===false || n.opacity===0) add('R-7-42',n,'Remove hidden or zero-opacity layers.');
      if(n.type==='frame' && !children.length && !n.fill && !/spacer/i.test(name(n))) add('R-7-42',n,'Remove the empty frame or give it a visible purpose.');
      if(n!==root && b.width>0 && b.height>0 && !overlaps(rb,b)) add('R-7-42',n,'Layer is fully outside its board.');
      if(n.type==='text') {
        const lines=String(n.content ?? '').split('\n').length;
        if(typeof n.height==='number' && b.height+0.1<num(n.fontSize)*(num(n.lineHeight)||1.2)*lines || /clip|overflow/i.test(b.problems ?? '')) add('R-7-33',n,'Text is clipped; allow enough height for its font and lines.');
      }
      if(/tab bar/i.test(name(n))) {
        const row=children.find((c:Node)=>/row|slots/i.test(name(c))) ?? n;
        const slots=(row.children ?? []).filter((c:Node)=>!/home (band|indicator)|spacer/i.test(name(c)));
        const active=slots.filter((s:Node)=>/\b(active|selected)\b/i.test(name(s)) || walk([s]).some(c=>c.type==='icon' && (c.variant==='filled' || /filled|solid/.test(String(c.icon)))));
        const bad=slots.length<3 || slots.length>5 || slots.some((s:Node)=>s.width!=='fill_container' || !walk([s]).some(c=>c.type==='icon'||c.type==='path') || !walk([s]).some(c=>c.type==='text'));
        const homeBand=nodes.find(c=>/home band/i.test(name(c)) && boxes[c.id].height===34 && Math.abs(boxes[c.id].y-(b.y+b.height))<1);
        const strokeBad=n.stroke && (typeof n.strokeWidth==='object' ? num(n.strokeWidth.top)>1 || ['left','right','bottom'].some(k=>num(n.strokeWidth[k])>0) : num(n.strokeWidth)>0);
        if(bad || active.length!==1 || !(b.height===83 || b.height===49 && homeBand) || Math.abs(b.y+b.height+(b.height===49?34:0)-(rb.y+rb.height))>0.5 || descendants.some(c=>[c.fill].flat().includes('$accent')) || strokeBad) add('R-7-4',n,'Use 3 to 5 equal tab slots with icon and label, exactly one active, and a continuous bar to the bottom edge.');
      }
      if(/empty (state|block)|empty-state/i.test(name(n))) {
        const inside=new Set(walk([n]).map(c=>c.id));
        const above=nodes.filter(c=>!inside.has(c.id) && c!==root && boxes[c.id].y+boxes[c.id].height<=b.y && c.enabled!==false);
        const top=Math.max(rb.y,...above.map(c=>boxes[c.id].y+boxes[c.id].height));
        const bottom=tab?boxes[tab.id].y:rb.y+rb.height-34;
        if(Math.abs(b.y+b.height/2-(top+bottom)/2)>24 || Math.abs(b.x+b.width/2-(rb.x+rb.width/2))>24) add('R-7-26',n,'Centre the empty-state block in the free space above the tab bar.');
      }
      if(n.type==='icon') {
        const state=nodes.some(p=>/state|empty|error|illustration/i.test(name(p)) && walk([p]).includes(n));
        if(b.width!==b.height || b.width<(state?32:16) || b.width>(state?64:28) || libraries.size>1) add('R-7-18',n,'Use square icons in the allowed size range and one library per file.');
      }
      if(n.layout==='horizontal' || /row|actions|tab bar/i.test(name(n))) {
        const icons=children.flatMap((slot:Node)=>slot.type==='icon'?[slot]:slot.layout==='horizontal' || /row|actions|tab bar/i.test(name(slot))?[]:(slot.children ?? []).filter((c:Node)=>c.type==='icon'));
        if(new Set(icons.map((c:Node)=>`${boxes[c.id].width}:${boxes[c.id].height}:${c.library}`)).size>1) add('R-7-18',n,'Sibling icon slots in one row must share size and library.');
      }
      if(/website|landing/i.test(name(root))) {
        if(/app store|google play|badge/i.test(name(n)) && (!image(n) || !n.metadata?.officialBadge)) add('R-7-51',n,'Insert the official store badge as an image.');
        const short=n.type==='text' && String(n.content ?? '').length<120;
        if(rb.width===393 && short && nodes.some(p=>/hero|section header|section heading/i.test(name(p)) && walk([p]).includes(n)) && n.textAlign!=='center') add('R-7-51',n,'Centre short hero and section-header text on phone-width websites.');
      }
    }
  }
  for(let i=0;i<roots.length;i++) for(let j=i+1;j<roots.length;j++) {
    const a=roots[i],b=roots[j];
    if(a.reusable || b.reusable || (boards && !boards.includes(a.id) && !boards.includes(b.id)) || (pages[a.id] ?? a.page ?? '')!==(pages[b.id] ?? b.page ?? '')) continue;
    const labelBox=(n:Node):Box=>{const r=boxes[n.id];return n.type==='frame'?{...r,y:r.y-28,height:r.height+28}:r;};
    if(overlaps(labelBox(a),labelBox(b))) add('canvas-overlap',b,`Board or label overlaps ${name(a)} on the same page.`);
  }
  return issues;
}
