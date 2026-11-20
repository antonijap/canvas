import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyPeerPreviews } from '../src/page/presence-client.js';
test('peer previews draw moves, scrubs and typing without writing document state', () => {
    const original={id:'Board',children:[{id:'Title',type:'text',x:10,y:20,width:100,content:'Original'}]};
    const scene=structuredClone(original);
    assert.equal(applyPeerPreviews(scene,[{preview:{kind:'move',ids:['Title'],dx:4,dy:8},editing:{id:'Title',text:'Typing'}}]),true);
    assert.deepEqual(scene.children[0],{...original.children[0],x:14,y:28,content:'Typing'});
    assert.equal(original.children[0].content,'Original');
    applyPeerPreviews(scene,[{preview:{kind:'scrub',ids:['Title'],key:'opacity',value:0.4}}]);
    assert.equal((scene.children[0] as any).opacity,0.4);
    applyPeerPreviews(scene,[{preview:{kind:'scrub',ids:['Title'],key:'children',value:12}}]);
    assert.equal((scene.children[0] as any).children,undefined);
});
