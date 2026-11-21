import { randomUUID } from 'node:crypto';
export type Node = Record<string, any>;
export const id = () => 'design_' + randomUUID().replaceAll('-','');
export function walk(nodes: Node[]): Node[] { return nodes.flatMap(n => [n, ...walk(n.children ?? [])]); }

// Measured at 3x: 393-wide system glyphs occupy x282..361, y23..35.
// Compact width uses x294..360, y18..29, and time x32..64.
export function statusBar(width: 375 | 393 = 393, theme: 'light' | 'dark' = 'light'): Node {
  const compact = width === 375, ink = theme === 'light' ? '#000000' : '#FFFFFF';
  const path = (name: string, x: number, y: number, w: number, h: number, geometry: string, props: Node = {}) => ({id:id(),type:'path',name,x,y,width:w,height:h,viewBox:[0,0,w,h],geometry,fill:ink,...props});
  const sx = compact ? 294 : 282, gy = compact ? 18 : 23;
  const children: Node[] = [
    {id:id(),type:'text',name:'Time',x:compact ? 32 : 54,y:compact ? 14 : 19,width:54,height:22,content:'9:41',fontFamily:'SF Pro',fontSize:17,fontWeight:'600',lineHeight:1.294,textAlign:compact?'left':'center',fill:ink},
    path('Cellular signal',sx,gy,19,12,'M1 7H3Q4 7 4 8V11Q4 12 3 12H1Q0 12 0 11V8Q0 7 1 7Z M6 5H8Q9 5 9 6V11Q9 12 8 12H6Q5 12 5 11V6Q5 5 6 5Z M11 2H13Q14 2 14 3V11Q14 12 13 12H11Q10 12 10 11V3Q10 2 11 2Z M16 0H18Q19 0 19 1V11Q19 12 18 12H16Q15 12 15 11V1Q15 0 16 0Z'),
    path('Wi-Fi',compact?316:309,gy,17,12,'M0 3.4Q8.5 -3.4 17 3.4L14.7 5.7Q8.5 0.7 2.3 5.7Z M3.8 7.2Q8.5 3.4 13.2 7.2L10.9 9.5Q8.5 7.6 6.1 9.5Z M6.5 10.1Q8.5 8.5 10.5 10.1L8.5 12Z'),
    path('Battery outline',compact?337:335,gy,25,12,'M4 0.5H20Q23 0.5 23 3.5V8.5Q23 11.5 20 11.5H4Q1 11.5 1 8.5V3.5Q1 0.5 4 0.5Z M24 4V8Q26 7 26 6Q26 5 24 4Z',{fill:undefined,stroke:ink,strokeWidth:1,opacity:0.4,viewBox:[0,0,26,12]}),
    path('Battery charge',compact?340:338,gy+2,17,8,'M1 0H16Q17 0 17 1V7Q17 8 16 8H1Q0 8 0 7V1Q0 0 1 0Z'),
  ];
  return {id:id(),type:'frame',name:'iOS status bar',width,height:compact?44:54,layout:'none',children,metadata:{designHelper:`ios-status-bar:${width}:${theme}`}};
}

export function componentPlan(doc: Node, template: Node, position: Node) {
  if(template.metadata?.designHelper?.startsWith('ios-status-bar:') && doc.variables?.text) {
    template=structuredClone(template);
    for(const layer of walk([template])) {
      if(layer.fill) layer.fill='$text';
      if(layer.stroke) layer.stroke='$text';
    }
  }
  const key = template.metadata.designHelper;
  const existing = walk(doc.children ?? []).find(n => n.reusable && n.metadata?.designHelper === key);
  const main: Node | undefined = existing ? undefined : {...template,reusable:true};
  const target = existing ?? main!;
  return {main,instance:{id:id(),type:'ref',ref:target.id,name:target.name,width:target.width,height:target.height,...position}};
}
