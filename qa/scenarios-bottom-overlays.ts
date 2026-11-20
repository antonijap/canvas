import fs from "node:fs";
import path from "node:path";
import { sc, type T } from "./harness.ts";

sc('comments', 'Bottom pill positions share canvas center and zoom center', { covers: ['comments:light', 'comments:dark'], skip: { visual: 'Measured at multiple widths and saved review screenshots.' } }, async (t: T) => {
  await t.open({ native: true });
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
