import { createPresenceSender, createPeers, toScreen, selectionBoxes, previewBoxes } from './presence-client.js';

const host = window.canvasHost;
if (host?.file && host.es) start(host);

function start(host) {
  const peers = createPeers(), { view } = host;
  let enabled = !!window.canvasCloudFile, raf = 0, hidden = document.hidden;
  const sender = createPresenceSender({ send: p => {
    if (!enabled) return;
    fetch('/api/cloud/files/presence', { method:'POST', headers:{'x-canvas':'1','content-type':'application/json'}, body:JSON.stringify({file:host.file,p}), keepalive:true }).catch(()=>{});
  } });
  const update = p => { if (enabled) sender.update({ page:host.page, ...p }); };
  const layer = document.createElement('div'); layer.className = 'cp-layer'; layer.setAttribute('aria-label','People in this file'); view.appendChild(layer);
  const style = document.createElement('style');
  style.textContent = `.cp-layer{position:absolute;inset:0;pointer-events:none;z-index:12;overflow:hidden;font:11px var(--c-font-sans)}.cp-layer *{pointer-events:none;box-sizing:border-box}.cp-cursor,.cp-selection,.cp-preview,.cp-editing{position:absolute}.cp-cursor{white-space:nowrap}.cp-cursor span,.cp-editing{padding:4px 6px;border-radius:5px;white-space:pre-wrap;max-width:260px}.cp-cursor span{position:absolute;left:13px;top:18px;white-space:nowrap}.cp-selection,.cp-preview{border:1.5px solid currentColor}.cp-preview{border-style:dashed;background:color-mix(in srgb,currentColor 8%,transparent)}.cp-editing{font-weight:500}`;
  document.head.appendChild(style);
  function box(cls, r, p) {
    const el=document.createElement('div'), at=toScreen(r,host.cam);
    el.className=cls; el.dataset.peer=p.session; el.style.cssText=`left:${at.x}px;top:${at.y}px;width:${r.w*host.cam.z}px;height:${r.h*host.cam.z}px;color:${p.color}`;
    layer.appendChild(el); return el;
  }
  function draw(now) {
    raf=0; layer.replaceChildren();
    const list=hidden ? [] : peers.view(now,host.page);
    host.live?.setPeerPreviews?.(list);
    if (host.cam) for (const p of list) {
      for(const r of selectionBoxes(p.sel,host.worldRectOf)) box('cp-selection',r,p);
      for(const r of previewBoxes(p.preview,host.worldRectOf)) box('cp-preview',r,p);
      if(p.cursor) {
        const at=toScreen(p.cursor,host.cam), el=document.createElement('div');
        el.className='cp-cursor' + (p.agent ? ' cp-agent' : ''); el.dataset.peer=p.session; el.style.cssText=`left:${at.x}px;top:${at.y}px;opacity:${p.opacity};color:${p.color}`;
        el.innerHTML='<svg width="17" height="21" viewBox="0 0 17 21"><path d="M1 1v16l5-4 3 7 3-1-3-7h6z" fill="currentColor" stroke="white" stroke-width="1.4"/></svg>';
        const name=document.createElement('span'); name.textContent=p.name; name.style.cssText=`background:${p.color};color:${p.ink}`;el.appendChild(name);layer.appendChild(el);
      }
      const id=p.editing?.id || (p.preview?.kind==='scrub' && p.preview.ids[0]);
      if(id) {
        const r=host.worldRectOf(id);
        if(r) { const at=toScreen({x:r.x,y:r.y},host.cam), el=document.createElement('div');el.className='cp-editing';el.dataset.peer=p.session;
          el.textContent=p.editing ? `${p.name} is editing` : `${p.name}: ${p.preview.key} ${p.preview.value}`;
          el.style.cssText=`left:${at.x}px;top:${at.y-28}px;background:${p.color};color:${p.ink}`;layer.appendChild(el); }
      }
    }
    if(peers.busy(now) && !hidden) raf=requestAnimationFrame(draw);
  }
  function frame() { if(!raf) raf=requestAnimationFrame(draw); }
  function receive(list) { peers.receive(list,performance.now());frame(); }
  host.presence={ update, end:() => { if(enabled)sender.end({page:host.page}); }, receive, get peers(){return peers.view(performance.now(),host.page);} };
  for(const p of host.presenceEarly || []) receive(p);
  host.presenceEarly=null;
  host.es.addEventListener('cloudfile',()=>{ enabled=!!window.canvasCloudFile; });
  host.es.addEventListener('cloudremoved',()=>{enabled=false;sender.dispose();peers.clear();frame();});
  view.addEventListener('pointermove',e=>{
    if(!host.cam) return;
    const r=view.getBoundingClientRect(), c=host.cam;
    update({cursor:{x:(e.clientX-r.left-c.x)/c.z,y:(e.clientY-r.top-c.y)/c.z},sel:host.selection().slice(0,20)});
  },{passive:true});
  view.addEventListener('pointerleave',()=>update({cursor:null}),{passive:true});
  addEventListener('pointerup',()=>host.presence.end(),true);
  addEventListener('pointercancel',()=>host.presence.end(),true);
  host.on('select',()=>update({sel:host.selection().slice(0,20)}));
  host.on('deselect',()=>update({sel:[]}));
  host.on('page',()=>{update({sel:host.selection().slice(0,20)});frame();});
  host.on('cam',frame);host.on('render',frame);
  host.on('presence',update);
  host.on('cmd',c=>{
    if(c.cmd==='edit' && c.preview) {
      const found=Object.entries(c.props || {}).find(([,v])=>typeof v==='number');
      if(found) update({preview:{kind:'scrub',ids:[c.id],key:found[0],value:found[1]}});
    } else if(c.cmd==='editDone') host.presence.end();
  });
  function setHidden(h) { hidden=h;sender.setHidden(h);frame(); }
  document.addEventListener('visibilitychange',()=>setHidden(document.hidden));
  host.on('tab',on=>setHidden(!on || document.hidden));
  addEventListener('pagehide',()=>{sender.dispose();peers.clear();cancelAnimationFrame(raf);});
}
