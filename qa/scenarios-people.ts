import fs from 'node:fs';
import path from 'node:path';
import { sc, type T } from './harness.ts';

sc('cloud', 'People strip shows live peers, roles, overflow and cursor navigation', { covers: ['cloud-files:presence'], skip: { visual: 'Live avatars and camera movement are measured; review screenshots are saved.' } }, async (t: T) => {
  await t.focus('lay_nest');
  await t.ev("document.getElementById('rev').style.visibility='hidden'");
  await t.waitFor('!!window.canvasHost.presence && !!window.canvasHost.comments', 'presence');
  await t.ev(`(() => {
    const original = window.fetch; window.fetch = async (u, o) => {
      const r = await original(u, o);
      if (typeof u === 'string' && u.startsWith('/api/comments?file=')) { const j = await r.json(); j.me = 'Anna'; j.sync = { status:'connected', role:'editor', me:{name:'Anna'}, pending:[], rejected:[] }; return new Response(JSON.stringify(j)); }
      return r;
    };
    window.canvasCloudFile = { role:'editor', status:'connected', author:{name:'Anna'} };
    const h = window.canvasHost;
    h.presence.receive([0,1,2,3,4].map(i => ({ session:'peer-'+i, by:{name:i ? 'Ben '+i : 'Ben'}, role:'editor', page:h.page, cursor:{x:900+i*20,y:500},sel:[] })));
    return h.comments.reload();
  })()`);
  await t.settle();
  if (process.env.CANVAS_UI_SHOTS) { fs.mkdirSync(process.env.CANVAS_UI_SHOTS, { recursive:true }); fs.writeFileSync(path.join(process.env.CANVAS_UI_SHOTS, 'people-' + (process.env.CANVAS_UI_BEFORE ? 'before' : 'after') + '.png'), await t.shot()); }
  if (process.env.CANVAS_UI_BEFORE) return;
  const strip = await t.ev<any>(`(() => { const e = document.querySelector('.cm-shared'); return { names:[...e.querySelectorAll('button.cm-av')].map(e=>e.title), more:e.querySelector('.cm-more')?.textContent, dot:!!e.querySelector('.cm-dot'), colors:[...e.querySelectorAll('button.cm-av')].map(e=>e.style.backgroundColor) }; })()`);
  t.eq(strip.names, ['Anna, editor', 'Ben, editor', 'Ben 1, editor', 'Ben 2, editor'], 'you first then live people');
  t.eq(strip.more, '+2', 'overflow people'); t.eq(strip.dot, false, 'no status dot');
  const before = await t.ev<any>('({...window.canvasHost.cam})');
  await t.ev("document.querySelectorAll('.cm-shared button.cm-av')[1].click()");
  await t.settle();
  t.ok(await t.ev(`JSON.stringify(window.canvasHost.cam) !== ${JSON.stringify(JSON.stringify(before))}`), 'click moves camera');
  await t.ev(`window.canvasHost.presence.receive([0,1,2,3,4].map(i=>({session:'peer-'+i,by:{name:'Ben'},gone:true})))`);
  await t.settle();
  t.eq(await t.ev("document.querySelectorAll('.cm-shared button.cm-av').length"), 1, 'alone shows only you');
});
