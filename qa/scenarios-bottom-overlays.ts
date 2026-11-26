import fs from "node:fs";
import path from "node:path";
import { METRICS } from "../src/tokens.ts";
import { sc, type T } from "./harness.ts";

sc('bottom-overlays', 'Comment mode hint shares canvas center and zoom center', { covers: ['comments:light', 'comments:dark'], skip: { visual: 'Measured at multiple widths and saved review screenshots.' } }, async (t: T) => {
  await t.open({ native: true });
  await t.ev("document.getElementById('rev').style.visibility='hidden'");
  await t.waitFor('!!window.canvasHost.comments', 'comments');
  await t.ev("window.canvasCmd({cmd:'comment'})");
  for (const width of [720, 1280, 1800]) {
    await t.page.send('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
    await t.ev(`window.canvasCmd({cmd:'insets',l:80,t:64,r:280,b:64}); window.canvasCmd({cmd:'zoomCorner',left:${width - 148},bottom:782})`);
    await t.settle();
    if (process.env.CANVAS_UI_SHOTS && width === 1280) { fs.mkdirSync(process.env.CANVAS_UI_SHOTS, { recursive: true }); fs.writeFileSync(path.join(process.env.CANVAS_UI_SHOTS, 'pills-' + (process.env.CANVAS_UI_BEFORE ? 'before' : 'after') + '.png'), await t.shot()); }
    if (process.env.CANVAS_UI_BEFORE) continue;
    const b = await t.ev<any>(`(() => { const r = document.querySelector('.cm-hint').getBoundingClientRect(); return {cx:r.x+r.width/2,cy:r.y+r.height/2,right:r.right}; })()`);
    t.near(b.cx, (80 + width - 280)/2, 1, 'centered on free canvas');
    const pill = await t.ev<number>("parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--c-pill'))");
    t.near(b.cy, 782 - pill / 2, 1, 'same vertical center as zoom');
    t.ok(b.right < width - 148, 'clear of zoom');
  }
});

sc('comments', 'The Comments button opens the list and centers the chosen pin', { covers: ['comments:list-navigation'], skip: { visual: 'Sidebar and pin geometry measured; screenshot saved by runner.' } }, async (t: T) => {
  await t.focus('lay_nest');
  const r = await t.rect('r_free');
  await t.io.key('c');
  await t.io.click(r.x + r.w / 2, r.y + r.h / 2);
  await t.waitFor("!!document.querySelector('.cm-comp textarea')", 'composer');
  await t.io.type('Review this spacing');
  await t.io.key('Enter');
  await t.waitFor('window.canvasHost.comments.threads.length === 1', 'saved comment');
  await t.io.key('Escape');
  await t.waitFor("!!document.querySelector('.cv-btn')?.offsetWidth", "the Comments button");
  const click = async (selector: string) => {
    const p = await t.ev<any>(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
    await t.io.click(p.x, p.y);
  };
  await click('.cv-btn');
  await t.waitFor("!!document.querySelector('.cm-sidebar:not([hidden]) .cm-thread-row')", 'comments sidebar list');
  await t.ev('window.canvasHost.setCam({x:-9000,y:-9000,z:0.2})');
  await click('.cm-thread-row');
  await t.waitFor('!!window.canvasHost.comments.open', 'chosen thread');
  await t.settle();
  const g = await t.ev<any>(`(() => { const h=window.canvasHost, p=document.querySelector('.cm-pin').getBoundingClientRect(), s=document.querySelector('.cm-sidebar').getBoundingClientRect(), v=h.view.getBoundingClientRect(); return {x:p.x,y:p.bottom,cx:(v.left+(h.insets.l||0)+Math.min(v.right-(h.insets.r||0),s.left))/2,cy:(v.top+(h.insets.t||0)+v.bottom-(h.insets.b||0))/2}; })()`);
  t.near(g.x, g.cx, 2, 'pin tip centered horizontally in free canvas');
  t.near(g.y, g.cy, 2, 'pin tip centered vertically in free canvas');
  fs.writeFileSync(path.join(process.cwd(), 'qa/out/comments-sidebar-navigation.png'), await t.shot());
  await click('.cm-sidebar-head [aria-label="Close"]');
  await t.waitFor("document.querySelector('.cm-sidebar').hidden", 'sidebar closes');
  t.eq(await t.ev("document.activeElement === document.querySelector('.cv-btn')"), true, 'Close returns focus to Comments');
  await click('.cv-btn');
  await t.waitFor("!document.querySelector('.cm-sidebar').hidden && !window.canvasHost.comments.open", 'Comments returns to the list');
  const other = await t.ev<string>(`(async () => {
    const h=window.canvasHost, page=h.pages.find(p=>p.id!==h.page).id;
    const op={opId:crypto.randomUUID(),doc:h.comments.doc,at:new Date().toISOString(),op:{kind:'thread.create',thread:crypto.randomUUID(),comment:crypto.randomUUID(),anchor:{x:120,y:80,page},body:'Review another page'}};
    const response=await fetch('/api/comments/ops?file='+encodeURIComponent(h.file),{method:'POST',headers:{'x-canvas':'1','content-type':'application/json'},body:JSON.stringify({ops:[op]})});
    const result=await response.json(); if(!response.ok || result.rejected?.length) throw new Error(JSON.stringify(result));
    await h.comments.reload(); return page;
  })()`);
  await t.waitFor("document.querySelectorAll('.cm-thread-row').length === 2", 'list includes other pages');
  const rowOrder = await t.ev<string[]>(`[...document.querySelectorAll('.cm-thread-body')].map(el => el.textContent)`);
  await click(`.cm-thread-row:nth-of-type(${rowOrder.indexOf('Review another page') + 1})`);
  await t.waitFor(`window.canvasHost.page === ${JSON.stringify(other)} && !!window.canvasHost.comments.open`, 'other page comment opens');
});

sc('bottom-overlays', 'Comments has a flush browser panel and compact header', {
  covers: ['sidebar:menu'], skip: { visual: 'Panel and header geometry and computed styles are asserted.' },
}, async (t: T) => {
  await t.waitFor("!!document.querySelector('.cv-btn')", 'Comments is ready');
  await t.ev("document.querySelector('.cv-btn').click()");
  await t.waitFor("!!document.querySelector('.cm-sidebar:not([hidden]) .cm-sidebar-head')", 'Comments opens');
  t.eq(await t.ev("document.querySelector('.cm-empty').textContent"), 'No comments yet', 'the empty state');
  const r = await t.ev<any>(`(() => {
    const panel = document.querySelector('.cm-sidebar'), header = panel.querySelector('.cm-sidebar-head');
    const p = panel.getBoundingClientRect(), h = header.getBoundingClientRect();
    const close = header.querySelector('[aria-label^="Close"]');
    const button = close.getBoundingClientRect();
    return { top:p.top, right:innerWidth-p.right, bottom:innerHeight-p.bottom, width:p.width,
      closeCenter: p.right - (button.left + button.width / 2),
      headerHeight:h.height, closeWidth:close.offsetWidth, closeText:close.textContent,
      radius:getComputedStyle(panel).borderRadius, shadow:getComputedStyle(panel).boxShadow };
  })()`);
  t.near(r.right, 0, 1, 'panel reaches the right edge');
  t.near(r.bottom, 0, 1, 'panel reaches the bottom');
  t.near(r.top, 0, 1, 'panel starts at the top');
  t.near(r.width, METRICS.sidebarWidth, 1, 'panel width');
  t.near(r.headerHeight, METRICS.control, 1, 'header height');
  t.ok(r.closeWidth >= 24 && r.closeWidth <= 28 && !r.closeText, 'the close control is icon-only');
  t.near(r.closeCenter, METRICS.sidebarInset + METRICS.sidebarRow / 2, 1, 'Close aligns with the trailing action column');
  t.eq(r.radius, '0px', 'square panel corners');
  t.eq(r.shadow, 'none', 'flat panel edge');
});

sc('bottom-overlays', 'Both commands and the browser button toggle Comments', {
  covers: ['sidebar:menu'],
  skip: { visual: 'The actual pointer click verifies the shortcut is exposed.' },
}, async (t: T) => {
  await t.waitFor("!!document.querySelector('.cv-btn') && !!document.querySelector('.cm-sidebar')", 'Comments is ready');
  await t.ev("window.canvasCmd({cmd:'conversations',open:true})");
  await t.waitFor("!document.querySelector('.cm-sidebar').hidden", 'Comments opens');
  await t.ev("window.canvasCmd({cmd:'commentsSidebar',open:true})");
  t.eq(await t.ev("document.querySelector('.cv-btn').getAttribute('aria-expanded')"), 'true', 'Comments stays open');
  const point = await t.ev<{x: number; y: number}>(`(() => {
    const r = document.querySelector('.cv-btn').getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  })()`);
  t.ok(await t.ev(`(() => {
    const close = document.querySelector('.cm-sidebar-head [aria-label="Close"]');
    const r = close.getBoundingClientRect();
    return close.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  })()`), 'the Comments close control is also reachable');
  await t.io.click(point.x, point.y);
  await t.waitFor("document.querySelector('.cm-sidebar').hidden", 'the browser button closes Comments');
  await t.ev("window.canvasCmd({cmd:'commentsSidebar'})");
  await t.waitFor("!document.querySelector('.cm-sidebar').hidden", 'Comments command toggles it open');
  await t.ev("window.canvasCmd({cmd:'conversations'})");
  await t.waitFor("document.querySelector('.cm-sidebar').hidden", 'Conversations command toggles it closed');
});
