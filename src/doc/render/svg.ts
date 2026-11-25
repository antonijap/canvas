// SVG export: the renderer's HTML page, laid out by Chrome, walked back into SVG. Boxes become rects or paths with
// their fills, gradients, strokes, shadows and clips; text stays text (one <text> per laid-out line, at Chrome's own
// positions and baselines); vector layers and icons keep their paths; image fills become <image> (the caller swaps
// their file URLs for data: URLs, so the file stands alone). What SVG cannot say (a conic gradient, a backdrop blur)
// is drawn as close as it can and named in the warnings.
// The helpers below are plain JS under their annotations: SVG_SCRIPT embeds their source, and tests call them.

type Radii = [number, number][];

/** "rgb(1, 2, 3)", "rgba(1, 2, 3, 0.5)", "transparent" or a hex as {hex, a}; null for anything else. */
export function parseColor(c: string): { hex: string; a: number } | null {
  const s = String(c || "").trim();
  if (!s || s === "transparent" || s === "none") return { hex: "#000000", a: 0 };
  const h = /^#([0-9a-f]{3,8})$/i.exec(s);
  if (h) {
    let v = h[1];
    if (v.length === 3 || v.length === 4) v = v.split("").map((x) => x + x).join("");
    const a = v.length === 8 ? parseInt(v.slice(6), 16) / 255 : 1;
    return { hex: "#" + v.slice(0, 6).toUpperCase(), a: Math.round(a * 1000) / 1000 };
  }
  const m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+%?))?\s*\)$/i.exec(s);
  if (!m) return null;
  const hex2 = (v: string) => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, "0");
  let a = m[4] === undefined ? 1 : m[4].endsWith("%") ? Number(m[4].slice(0, -1)) / 100 : Number(m[4]);
  if (!Number.isFinite(a)) a = 1;
  return { hex: ("#" + hex2(m[1]) + hex2(m[2]) + hex2(m[3])).toUpperCase(), a: Math.round(a * 1000) / 1000 };
}

/** Split a CSS list at its top-level commas ("a(1,2), b" -> ["a(1,2)", "b"]). */
export function splitTop(s: string, sep = ","): string[] {
  const out: string[] = [];
  let depth = 0, cur = "";
  for (const ch of String(s)) {
    if (ch === "(") depth++;
    else if (ch === ")") depth--;
    if (ch === sep && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** CSS linear-gradient's line for an angle (degrees, 0 up, clockwise) across a w by h box: its two ends. */
export function gradientLine(deg: number, w: number, h: number): { x1: number; y1: number; x2: number; y2: number } {
  const a = (deg * Math.PI) / 180;
  const dx = Math.sin(a), dy = -Math.cos(a);
  const len = Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a));
  const r = (v: number) => Math.round(v * 1000) / 1000 || 0;
  return { x1: r(w / 2 - (dx * len) / 2), y1: r(h / 2 - (dy * len) / 2), x2: r(w / 2 + (dx * len) / 2), y2: r(h / 2 + (dy * len) / 2) };
}

/** Gradient stops with CSS's rules for missing positions (ends at 0 and 1, gaps shared evenly, never going back). */
export function gradientStops(parts: string[]): { color: string; at: number }[] {
  const stops = parts.map((p) => {
    const m = /^(.*?)\s+(-?[\d.]+)%$/.exec(p.trim());
    return m ? { color: m[1], at: Number(m[2]) / 100 as number | null } : { color: p.trim(), at: null as number | null };
  });
  if (!stops.length) return [];
  if (stops[0].at === null) stops[0].at = 0;
  if (stops[stops.length - 1].at === null) stops[stops.length - 1].at = Math.max(1, ...stops.map((s) => s.at ?? 0));
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].at !== null) { stops[i].at = Math.max(stops[i].at as number, stops[i - 1].at as number); continue; }
    let j = i;
    while (stops[j].at === null) j++;
    const from = stops[i - 1].at as number, to = stops[j].at as number;
    for (let k = i; k < j; k++) stops[k].at = from + ((to - from) * (k - i + 1)) / (j - i + 1);
  }
  return stops.map((s) => ({ color: s.color, at: s.at as number }));
}

/** CSS border radii ("12px", "50%", "12px 6px") of the four corners (tl, tr, br, bl) in px, for a w by h box. */
export function cornerRadii(list: string[], w: number, h: number): Radii {
  return list.map((v) => {
    const p = String(v || "0").trim().split(/\s+/);
    const len = (x: string, of: number) => (x.endsWith("%") ? (Number(x.slice(0, -1)) / 100) * of : Number.parseFloat(x) || 0);
    return [len(p[0], w), len(p[1] ?? p[0], h)] as [number, number];
  });
}

/** Path data of a box with corner radii (tl, tr, br, bl as [rx, ry]), scaled down together the way CSS does when they overlap. */
export function roundedPath(x: number, y: number, w: number, h: number, radii: Radii): string {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  let f = 1;
  const fit = (a: number, b: number, len: number) => { if (a + b > len && a + b > 0) f = Math.min(f, Math.max(0, len) / (a + b)); };
  const q = radii.map(([a, b]) => [Math.max(0, a), Math.max(0, b)]);
  fit(q[0][0], q[1][0], w); fit(q[3][0], q[2][0], w); fit(q[0][1], q[3][1], h); fit(q[1][1], q[2][1], h);
  const [tl, tr, br, bl] = q.map(([a, b]) => [a * f, b * f]);
  const arc = (c: number[], ex: number, ey: number) => (c[0] && c[1] ? `A${r(c[0])} ${r(c[1])} 0 0 1 ${r(ex)} ${r(ey)}` : "");
  return `M${r(x + tl[0])} ${r(y)}H${r(x + w - tr[0])}${arc(tr, x + w, y + tr[1])}V${r(y + h - br[1])}${arc(br, x + w - br[0], y + h)}H${r(x + bl[0])}${arc(bl, x, y + h - bl[1])}V${r(y + tl[1])}${arc(tl, x + tl[0], y)}Z`;
}

/** The outline of a box with corner radii: a rect when it can be one, else a path. */
export function roundedShape(x: number, y: number, w: number, h: number, radii: Radii): { tag: "rect" | "path"; attrs: string } {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  const q = radii.map(([a, b]) => [Math.max(0, a), Math.max(0, b)]);
  if (q.every(([a, b]) => a === 0 || b === 0)) return { tag: "rect", attrs: `x="${r(x)}" y="${r(y)}" width="${r(Math.max(0, w))}" height="${r(Math.max(0, h))}"` };
  const same = q.every(([a, b]) => a === q[0][0] && b === q[0][1]);
  if (same && q[0][0] * 2 <= w && q[0][1] * 2 <= h) return { tag: "rect", attrs: `x="${r(x)}" y="${r(y)}" width="${r(w)}" height="${r(h)}" rx="${r(q[0][0])}" ry="${r(q[0][1])}"` };
  return { tag: "path", attrs: `d="${roundedPath(x, y, w, h, radii)}"` };
}

/** Runs in the page (after LAYOUT_SCRIPT laid it out): window.__svg(id) is that node as a standalone SVG string. */
export const SVG_SCRIPT = `${parseColor.toString()}
${splitTop.toString()}
${gradientLine.toString()}
${gradientStops.toString()}
${cornerRadii.toString()}
${roundedPath.toString()}
${roundedShape.toString()}
window.__svg=function(id){
  let root=document.querySelector('[data-id="'+CSS.escape(id)+'"]');
  if(root?.dataset.stickerAlias)root=document.querySelector('[data-id="'+CSS.escape(root.dataset.stickerAlias)+'"]');
  if(!root)throw new Error('nothing drawn for "'+id+'" (it may be hidden)');
  const warn=new Set();const defs=[];let uid=0;const nid=(p)=>p+(++uid);
  const esc=(s)=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const n=(v)=>Math.round(v*1000)/1000;
  // Transforms off while measuring: every box is then its layout box, and each transform goes back on as a group.
  const tf=new Map();
  for(const el of [root,...root.querySelectorAll('[data-id]')]){const cs=getComputedStyle(el);
    if(cs.transform&&cs.transform!=='none'){tf.set(el,{m:new DOMMatrix(cs.transform),o:cs.transformOrigin,was:el.style.transform});el.style.transform='none';}}
  // The ancestors' transforms go off too (not back on): a layer exports as itself, not stretched or turned by the frames around it.
  const anc=[];for(let p=root.parentElement;p&&p!==document.documentElement;p=p.parentElement){const t=getComputedStyle(p).transform;if(t&&t!=='none'){anc.push([p,p.style.transform]);p.style.transform='none';}}
  const paintAttr=(c,k)=>{const p=parseColor(c);if(!p)return ' '+k+'="'+esc(c)+'"';if(p.a<=0)return ' '+k+'="none"';return ' '+k+'="'+p.hex+'"'+(p.a<1?' '+k+'-opacity="'+p.a+'"':'');};
  const stopsOf=(parts)=>gradientStops(parts).map(s=>{const p=parseColor(s.color)||{hex:'#000000',a:1};return '<stop offset="'+n(s.at)+'" stop-color="'+p.hex+'"'+(p.a<1?' stop-opacity="'+p.a+'"':'')+'/>';}).join('');
  // One CSS background layer as an SVG paint for a w x h box: {fill} or null when it paints nothing.
  const paintOf=(layer,w,h)=>{
    const m=/^([a-z-]+)\\((.*)\\)$/s.exec(layer.trim());if(!m)return null;
    const args=splitTop(m[2]);
    if(m[1]==='linear-gradient'){let deg=180;const a=args[0];
      const ang=/^(-?[\\d.]+)(deg|turn|rad)$/.exec(a);
      if(ang){deg=Number(ang[1])*(ang[2]==='turn'?360:ang[2]==='rad'?180/Math.PI:1);args.shift();}
      else if(/^to /.test(a)){const t=a.slice(3);deg={'top':0,'right':90,'bottom':180,'left':270,'top right':45,'right top':45,'bottom right':135,'right bottom':135,'bottom left':225,'left bottom':225,'top left':315,'left top':315}[t]??180;args.shift();}
      const st=gradientStops(args);
      if(st.length&&st.every(s=>s.color===st[0].color))return {fill:paintAttr(st[0].color,'fill')};
      const g=gradientLine(deg,w,h);const gid=nid('g');
      defs.push('<linearGradient id="'+gid+'" gradientUnits="userSpaceOnUse" x1="'+g.x1+'" y1="'+g.y1+'" x2="'+g.x2+'" y2="'+g.y2+'">'+stopsOf(args)+'</linearGradient>');
      return {fill:' fill="url(#'+gid+')"'};}
    if(m[1]==='radial-gradient'){let shape='';
      if(!/^(rgb|#|transparent|hsl|color)/.test(args[0]))shape=args.shift();
      let cx=w/2,cy=h/2,rx=w/2,ry=h/2;
      const at=/at\\s+(-?[\\d.]+)(%|px)\\s+(-?[\\d.]+)(%|px)/.exec(shape);
      if(at){cx=at[2]==='%'?Number(at[1])/100*w:Number(at[1]);cy=at[4]==='%'?Number(at[3])/100*h:Number(at[3]);}
      const sz=/^(?:ellipse\\s+|circle\\s+)?(-?[\\d.]+)(%|px)(?:\\s+(-?[\\d.]+)(%|px))?/.exec(shape);
      if(sz){rx=sz[2]==='%'?Number(sz[1])/100*w:Number(sz[1]);ry=sz[3]===undefined?rx:sz[4]==='%'?Number(sz[3])/100*h:Number(sz[3]);}
      else{rx=Math.hypot(Math.max(cx,w-cx),Math.max(cy,h-cy));ry=rx;}
      const gid=nid('g');rx=Math.max(rx,0.001);
      defs.push('<radialGradient id="'+gid+'" gradientUnits="userSpaceOnUse" cx="'+n(cx)+'" cy="'+n(cy)+'" r="'+n(rx)+'" gradientTransform="translate('+n(cx)+' '+n(cy)+') scale(1 '+n(ry/rx)+') translate('+n(-cx)+' '+n(-cy)+')">'+stopsOf(args)+'</radialGradient>');
      return {fill:' fill="url(#'+gid+')"'};}
    if(m[1]==='conic-gradient'){warn.add('an angular gradient is drawn as its first colour');
      const st=gradientStops(args.filter(a=>!/^from |^at /.test(a)));return st.length?{fill:paintAttr(st[0].color,'fill')}:null;}
    return null;};
  const radiiOf=(cs,w,h)=>cornerRadii([cs.borderTopLeftRadius,cs.borderTopRightRadius,cs.borderBottomRightRadius,cs.borderBottomLeftRadius],w,h);
  const shape=(x,y,w,h,radii,extra)=>{const s=roundedShape(x,y,w,h,radii);return '<'+s.tag+' '+s.attrs+(extra||'')+'/>';};
  const grow=(radii,d)=>radii.map(([a,b])=>[a>0?Math.max(0,a+d):0,b>0?Math.max(0,b+d):0]);
  const blurFilter=(sd)=>{const f=nid('f');defs.push('<filter id="'+f+'" x="-1" y="-1" width="3" height="3"><feGaussianBlur stdDeviation="'+n(sd)+'"/></filter>');return f;};
  const shadowsOf=(v)=>v&&v!=='none'?splitTop(v).map(s=>{const inset=/\\binset\\b/.test(s);const c=(/(rgba?\\([^)]*\\)|#[0-9a-f]+)/i.exec(s)||[''])[0];
    const nums=s.replace(c,'').replace('inset','').trim().split(/\\s+/).map(parseFloat);return {inset,color:c,x:nums[0]||0,y:nums[1]||0,blur:nums[2]||0,spread:nums[3]||0};}):[];
  const backgrounds=(cs,w,h,radii)=>{let out='';
    const col=parseColor(cs.backgroundColor);if(col&&col.a>0)out+=shape(0,0,w,h,radii,paintAttr(cs.backgroundColor,'fill'));
    if(cs.backgroundImage&&cs.backgroundImage!=='none'){for(const layer of splitTop(cs.backgroundImage).reverse()){const p=paintOf(layer,w,h);if(p)out+=shape(0,0,w,h,radii,p.fill);}}
    return out;};
  const imgOut=(img,pr,radii)=>{const r=img.getBoundingClientRect();const cs=getComputedStyle(img);
    const fit=cs.objectFit==='contain'?'xMidYMid meet':cs.objectFit==='fill'?'none':'xMidYMid slice';
    const cp=nid('c');defs.push('<clipPath id="'+cp+'">'+shape(r.left-pr.left,r.top-pr.top,r.width,r.height,radii)+'</clipPath>');
    const op=Number(cs.opacity);
    return '<image href="'+esc(img.tagName==='CANVAS'?img.toDataURL('image/png'):img.currentSrc||img.src)+'" x="'+n(r.left-pr.left)+'" y="'+n(r.top-pr.top)+'" width="'+n(r.width)+'" height="'+n(r.height)+'" preserveAspectRatio="'+fit+'" clip-path="url(#'+cp+')"'+(op<1?' opacity="'+op+'"':'')+'/>';};
  const vecOut=(svg,pr,color)=>{const r=svg.getBoundingClientRect();const k=svg.cloneNode(true);
    k.setAttribute('x',n(r.left-pr.left));k.setAttribute('y',n(r.top-pr.top));k.setAttribute('width',n(r.width));k.setAttribute('height',n(r.height));
    k.removeAttribute('style');k.setAttribute('overflow','visible');
    return new XMLSerializer().serializeToString(k).replace(/ xmlns="http:\\/\\/www\\.w3\\.org\\/2000\\/svg"/,'').replace(/currentColor/g,(parseColor(color)||{hex:'#000000'}).hex);};
  const ringOut=(div,pr)=>{const r=div.getBoundingClientRect();const cs=getComputedStyle(div);const x=r.left-pr.left,y=r.top-pr.top,w=r.width,h=r.height;
    const t=parseFloat(cs.paddingTop)||0,rt=parseFloat(cs.paddingRight)||0,b=parseFloat(cs.paddingBottom)||0,l=parseFloat(cs.paddingLeft)||0;
    const radii=radiiOf(cs,w,h);const inner=[[radii[0][0]-l,radii[0][1]-t],[radii[1][0]-rt,radii[1][1]-t],[radii[2][0]-rt,radii[2][1]-b],[radii[3][0]-l,radii[3][1]-b]].map(([a,c])=>[Math.max(0,a),Math.max(0,c)]);
    const dd=roundedPath(0,0,w,h,radii)+roundedPath(l,t,w-l-rt,h-t-b,inner);
    let paint=null;for(const layer of splitTop(cs.backgroundImage||'')){paint=paintOf(layer,w,h);if(paint)break;}
    return '<g transform="translate('+n(x)+' '+n(y)+')"><path d="'+dd+'" fill-rule="evenodd"'+(paint?paint.fill:' fill="none"')+'/></g>';};
  const ctx=document.createElement('canvas').getContext('2d');
  const textOut=(el,er,cs)=>{const lines=[];
    // Styled ranges (a text's spans) are <span>s of their own: each run of letters keeps its element's style.
    // Paragraphs (spacing, indent, lists) are blocks of their own, a list marker a span in them: every level is walked.
    const runs=[];const collect=(p,src)=>{for(const c of p.childNodes){if(c.nodeType===3)runs.push([c,src]);else if((c.nodeName==='SPAN'||c.nodeName==='DIV')&&!(c.dataset&&c.dataset.id))collect(c,c);}};collect(el,el);
    // Letter case (text-transform): the DOM draws each letter in its case where the range measures it; the SVG writes
    // that letter (engine/src/scene.rs apply_case: upper, lower with a final sigma; title case is a span in upper case
    // around each word's first letter).
    const cases=new Map();const caseOf=(src)=>{let v=cases.get(src);if(v===undefined){v=(src===el?cs:getComputedStyle(src)).textTransform||'none';cases.set(src,v);}return v;};
    let p1='';
    const cased=(ch,src,next)=>{const tt=caseOf(src);
      if(tt==='uppercase')return ch.toUpperCase();
      if(tt==='lowercase')return ch==='\\u03a3'&&/\\p{L}/u.test(p1)&&!/\\p{L}/u.test(next||'')?'\\u03c2':ch.toLowerCase();
      return ch;};
    // A run that goes on where the last one stopped, on its line in the same look (a title-case letter's span), carries
    // on the same <text>.
    const keys=new Map();const keyOf=(src)=>{let k=keys.get(src);if(k===undefined){const c=src===el?cs:getComputedStyle(src);k=[c.fontFamily,c.fontSize,c.fontWeight,c.fontStyle,c.letterSpacing,c.textDecorationLine,c.fontFeatureSettings,c.color,c.webkitTextStrokeWidth,c.webkitTextStrokeColor].join('|');keys.set(src,k);}return k;};
    let cur=null;
    for(const [t,src] of runs){const s=t.data;let first=true;
      for(let i=0;i<s.length;){const cp=s.codePointAt(i);const len=cp>0xffff?2:1;const ch=s.slice(i,i+len);
        const rg=document.createRange();rg.setStart(t,i);rg.setEnd(t,i+len);const q=rg.getClientRects()[0];i+=len;
        if(ch==='\\n'){cur=null;p1='';continue;}
        const out=cased(ch,src,s[i]);p1=ch;if(!q)continue;
        if(first&&cur&&!(keyOf(cur.src)===keyOf(src)&&Math.abs(q.left-cur.right)<0.75))cur=null;
        first=false;
        if(!cur||Math.abs(q.top-cur.top)>q.height/2){cur={top:q.top,h:q.height,x:q.left,text:'',src};lines.push(cur);}cur.text+=out;cur.right=q.right;}}
    if(!lines.length)return '';
    let gfill=null;
    if((cs.webkitBackgroundClip||cs.backgroundClip)==='text'&&cs.backgroundImage!=='none'){const p=paintOf(splitTop(cs.backgroundImage)[0],er.width,er.height);if(p)gfill=p.fill;}
    const looks=new Map();
    const look=(src)=>{let o=looks.get(src);if(o)return o;const c=src===el?cs:getComputedStyle(src);
      ctx.font=c.fontStyle+' '+c.fontWeight+' '+c.fontSize+' '+c.fontFamily;const m=ctx.measureText('Hg');
      const sw=parseFloat(c.webkitTextStrokeWidth)||0;
      const stroke=sw?paintAttr(c.webkitTextStrokeColor,'stroke')+' stroke-width="'+n(sw)+'"':'';
      const ls=parseFloat(c.letterSpacing)||0;
      const deco=(c.textDecorationLine||'none')!=='none'?' text-decoration="'+esc(c.textDecorationLine)+'"':'';
      // Small caps: the font's own (smcp), as the canvas draws them.
      const feat=/smcp/.test(c.fontFeatureSettings||'')?' style="font-feature-settings:&quot;smcp&quot; 1"':'';
      const attrs=' font-family="'+esc(c.fontFamily.replace(/"/g,"'"))+'" font-size="'+n(parseFloat(c.fontSize))+'"'+(c.fontWeight!=='400'?' font-weight="'+c.fontWeight+'"':'')+(c.fontStyle!=='normal'?' font-style="'+c.fontStyle+'"':'')+(ls?' letter-spacing="'+n(ls)+'"':'')+deco+feat+(gfill||paintAttr(c.color,'fill'))+stroke;
      o={asc:m.fontBoundingBoxAscent,desc:m.fontBoundingBoxDescent,attrs};looks.set(src,o);return o;};
    return lines.map(l=>{const k=look(l.src);const base=l.top+(l.h-(k.asc+k.desc))/2+k.asc;
      return '<text x="'+n(l.x-er.left)+'" y="'+n(base-er.top)+'" xml:space="preserve"'+k.attrs+'>'+esc(l.text.replace(/\\s+$/,''))+'</text>';}).join('');};
  const node=(el,pr)=>{const cs=getComputedStyle(el);if(cs.display==='none'||cs.visibility==='hidden')return '';
    const r=el.getBoundingClientRect();const w=r.width,h=r.height;const x=pr?r.left-pr.left:0,y=pr?r.top-pr.top:0;
    let tr='translate('+n(x)+' '+n(y)+')';const t=tf.get(el);
    if(t){const o=t.o.split(/\\s+/).map(parseFloat);const M=t.m;tr+=' translate('+n(o[0]||0)+' '+n(o[1]||0)+') matrix('+[M.a,M.b,M.c,M.d,M.e,M.f].map(n).join(' ')+') translate('+n(-(o[0]||0))+' '+n(-(o[1]||0))+')';}
    const op=Number(cs.opacity);let filt='';
    if(cs.filter&&cs.filter!=='none'){const fid=nid('f');let fx='';let input='SourceGraphic';
      for(const f of cs.filter.match(/[a-z-]+\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)/g)||[]){
        const b=/^blur\\(([\\d.]+)px\\)/.exec(f);if(b){fx+='<feGaussianBlur in="'+input+'" stdDeviation="'+n(Number(b[1]))+'" result="'+(input=nid('r'))+'"/>';continue;}
        const d=/^drop-shadow\\((.*)\\)$/.exec(f);if(d){const s=shadowsOf(d[1])[0];const p=parseColor(s.color)||{hex:'#000000',a:0.25};
          fx+='<feDropShadow in="'+input+'" dx="'+n(s.x)+'" dy="'+n(s.y)+'" stdDeviation="'+n(s.blur)+'" flood-color="'+p.hex+'" flood-opacity="'+p.a+'" result="'+(input=nid('r'))+'"/>';}}
      if(fx){defs.push('<filter id="'+fid+'" x="-1" y="-1" width="3" height="3">'+fx+'</filter>');filt=' filter="url(#'+fid+')"';}}
    if(cs.backdropFilter&&cs.backdropFilter!=='none')warn.add('a background blur is not drawn in SVG');
    const radii=radiiOf(cs,w,h);
    let out='<g transform="'+tr+'"'+(op<1?' opacity="'+n(op)+'"':'')+filt+(el.dataset.id?' data-layer="'+esc(el.dataset.name||el.dataset.id)+'"':'')+'>';
    const sh=shadowsOf(cs.boxShadow);
    for(const s of sh.filter(s=>!s.inset).reverse()){const f=s.blur?blurFilter(s.blur/2):'';
      out+=shape(s.x-s.spread,s.y-s.spread,w+2*s.spread,h+2*s.spread,grow(radii,s.spread),paintAttr(s.color,'fill')+(f?' filter="url(#'+f+')"':''));}
    const masked=cs.webkitMaskImage&&cs.webkitMaskImage!=='none'?cs.webkitMaskImage:cs.maskImage&&cs.maskImage!=='none'?cs.maskImage:'';
    const mu=/url\\("?([^")]+)"?\\)/.exec(masked||'');
    if(mu&&!el.querySelector(':scope > svg')){const mid=nid('m');defs.push('<mask id="'+mid+'"><image href="'+esc(mu[1])+'" width="'+n(w)+'" height="'+n(h)+'" preserveAspectRatio="xMidYMid meet"/></mask>');
      out+='<rect width="'+n(w)+'" height="'+n(h)+'"'+paintAttr(cs.backgroundColor,'fill')+' mask="url(#'+mid+')"/>';}
    else if(!((cs.webkitBackgroundClip||cs.backgroundClip)==='text'))out+=backgrounds(cs,w,h,radii);
    for(const s of sh.filter(s=>s.inset)){const cp=nid('c');defs.push('<clipPath id="'+cp+'">'+shape(0,0,w,h,radii)+'</clipPath>');const f=s.blur?blurFilter(s.blur/2):'';
      const pad=Math.abs(s.x)+Math.abs(s.y)+s.blur*2+s.spread+10;const id2=roundedPath(s.x+s.spread,s.y+s.spread,Math.max(0,w-2*s.spread),Math.max(0,h-2*s.spread),grow(radii,-s.spread));
      out+='<g clip-path="url(#'+cp+')"><path d="M'+n(-pad)+' '+n(-pad)+'H'+n(w+pad)+'V'+n(h+pad)+'H'+n(-pad)+'Z'+id2+'" fill-rule="evenodd"'+paintAttr(s.color,'fill')+(f?' filter="url(#'+f+')"':'')+'/></g>';}
    let inner='';
    if([...el.childNodes].some(c=>(c.nodeType===3&&c.data.length)||((c.nodeName==='SPAN'||(c.nodeName==='DIV'&&el.dataset.t==='text'))&&!(c.dataset&&c.dataset.id)&&c.textContent.length)))inner+=textOut(el,r,cs);
    for(const c of el.children){
      if(c.dataset&&c.dataset.id)inner+=node(c,r);
      else if(c.tagName==='IMG'||(c.tagName==='CANVAS'&&c.dataset.shader!==undefined))inner+=imgOut(c,r,radii);
      else if(c instanceof SVGSVGElement)inner+=vecOut(c,r,cs.color);
      else if(c instanceof HTMLElement&&/(^|;)mask:/.test(c.getAttribute('style')||''))inner+=ringOut(c,r);}
    if(cs.overflow==='hidden'||cs.overflowX==='hidden'||el.hasAttribute('data-clip')){const cp=nid('c');defs.push('<clipPath id="'+cp+'">'+shape(0,0,w,h,radii)+'</clipPath>');out+='<g clip-path="url(#'+cp+')">'+inner+'</g>';}
    else out+=inner;
    const ow=parseFloat(cs.outlineWidth)||0;
    if(cs.outlineStyle!=='none'&&ow>0){const off=parseFloat(cs.outlineOffset)||0;const d=off+ow/2;
      out+=shape(-d,-d,w+2*d,h+2*d,grow(radii,d),' fill="none"'+paintAttr(cs.outlineColor,'stroke')+' stroke-width="'+n(ow)+'"');}
    return out+'</g>';};
  try{
    const rr=root.getBoundingClientRect();const w=rr.width,h=rr.height;
    // The exported box: the node's own, or the box around it once it is turned (what the PNG export draws too).
    let vb=[0,0,w,h];const t=tf.get(root);
    if(t){const o=t.o.split(/\\s+/).map(parseFloat);const M=new DOMMatrix().translate(o[0]||0,o[1]||0).multiply(t.m).translate(-(o[0]||0),-(o[1]||0));
      const ps=[[0,0],[w,0],[0,h],[w,h]].map(([x,y])=>M.transformPoint(new DOMPoint(x,y)));
      const xs=ps.map(p=>p.x),ys=ps.map(p=>p.y);vb=[Math.min(...xs),Math.min(...ys),Math.max(...xs)-Math.min(...xs),Math.max(...ys)-Math.min(...ys)];}
    const body=node(root,null);
    const svg='<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="'+n(vb[2])+'" height="'+n(vb[3])+'" viewBox="'+vb.map(n).join(' ')+'" fill="none">'+(defs.length?'<defs>'+defs.join('')+'</defs>':'')+body+'</svg>';
    return {svg,width:vb[2],height:vb[3],warnings:[...warn]};
  }finally{for(const [el,t] of tf)el.style.transform=t.was;for(const [el,was] of anc)el.style.transform=was;}
};`;
