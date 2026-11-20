import assert from 'node:assert/strict';
import { launchChrome, sleep } from '../fidelity/cdp.ts';
import type { Scratch } from './lib.ts';

/** Count the actual page's requests and the other page's relayed frames, separately from durable actions. */
export async function measurePresence(a: Scratch, b: Scratch, fa: string, fb: string) {
    const chrome=await launchChrome();
    try {
        const left=await chrome.newPage(), right=await chrome.newPage();
        await left.send('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:1,mobile:false});
        await right.send('Emulation.setDeviceMetricsOverride',{width:1100,height:800,deviceScaleFactor:1,mobile:false});
        await left.goto(a.base+'/?file='+encodeURIComponent(fa));
        await right.goto(b.base+'/?file='+encodeURIComponent(fb));
        const ready=async(p:typeof left)=>{const end=Date.now()+15000;while(!await p.eval('!!window.canvasHost?.presence && !!window.canvasHost?.boards.get("Board") && !!window.canvasCloudFile')){if(Date.now()>end)throw new Error('presence page not ready: '+p.console.slice(-3));await sleep(50);}};
        await ready(left);await ready(right);
        await left.send('Page.bringToFront');
        assert.equal(await left.eval('document.hidden'),false,'the moving page is in front');
        let requests=0;
        await left.send('Network.enable');
        left.on('Network.requestWillBeSent',e=>{if(e.request.url.includes('/api/cloud/files/presence'))requests++;});
        await right.eval(`window.presenceFrames=0;const original=window.canvasHost.presence.receive;window.canvasHost.presence.receive=list=>{window.presenceFrames++;original(list);};`);
        const pt=await left.eval<{x:number;y:number}>(`(()=>{const h=window.canvasHost,r=h.worldRectOf('Board'),c=h.cam,v=h.view.getBoundingClientRect();return {x:v.left+c.x+(r.x+30)*c.z,y:v.top+c.y+(r.y+80)*c.z};})()`);
        await left.send('Input.dispatchMouseEvent',{type:'mouseMoved',...pt});
        await left.send('Input.dispatchMouseEvent',{type:'mousePressed',...pt,button:'left',buttons:1,clickCount:1});
        await sleep(400); requests=0;await right.eval('window.presenceFrames=0');
        const began=Date.now();let i=0;
        while(Date.now()-began<60000) {
            const x=pt.x+30+20*Math.sin(i/15),y=pt.y+15*Math.cos(i/15);
            await left.send('Input.dispatchMouseEvent',{type:'mouseMoved',x,y,button:'left',buttons:1});
            await sleep(16);i++;
        }
        const relayed=await right.eval<number>('window.presenceFrames');
        assert.ok(requests>100 && requests<=600,`presence requests in a minute dragging: ${requests}`);
        assert.ok(relayed>100 && relayed<=600,`presence relays in a minute dragging: ${relayed}`);
        console.log(`PASS presence during a minute dragging: ${requests} sent, ${relayed} relayed`);
        await left.send('Input.dispatchMouseEvent',{type:'mouseReleased',...pt,button:'left',buttons:0,clickCount:1});
        await sleep(1000); requests=0;await right.eval('window.presenceFrames=0');
        const idle=Date.now();while(Date.now()-idle<60000)await sleep(500);
        assert.equal(requests,0,'presence requests at rest');
        assert.equal(await right.eval('window.presenceFrames'),0,'presence relays at rest');
        console.log('PASS presence at rest for a minute: 0 sent, 0 relayed');
    } finally { await chrome.stop(); }
}
