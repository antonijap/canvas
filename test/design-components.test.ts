import assert from 'node:assert/strict';
import { test } from 'node:test';
import { statusBar, componentPlan } from '../mcp/design/components.ts';

test('status bar has measured positions, text and vector glyphs in both widths and themes', () => {
  for (const width of [375,393] as const) for (const theme of ['light','dark'] as const) {
    const n = statusBar(width, theme);
    assert.equal(n.width, width); assert.equal(n.height, width === 393 ? 54 : 44);
    assert.equal(n.children[0].content, '9:41'); assert.equal(n.children[0].fontSize,17);
    assert.equal(n.children[0].fontWeight,'600'); assert.equal(n.children[0].fontFamily,'SF Pro');
    assert.equal(n.children.filter((c: any) => c.type === 'path').length, 4);
    assert.ok(n.children.every((c: any) => c.x + c.width <= width));
  }
});
test('first insertion registers a reusable main and all placements are instances', () => {
  const main = statusBar(393,'light');
  const first = componentPlan({children:[]},main,{x:0,y:0});
  assert.equal(first.main?.reusable,true); assert.equal(first.instance.ref,first.main?.id);
  const second = componentPlan({children:[first.main]},main,{x:5,y:10});
  assert.equal(second.main,undefined); assert.equal(second.instance.ref,first.instance.ref);
  assert.notEqual(second.instance.id,first.instance.id);
});
test('status bar component binds ink to the file text token when available',()=>{
 const plan=componentPlan({children:[],variables:{text:{type:'color',value:'#123456'}}},statusBar(),{});
 assert.ok(plan.main!.children.every((n:any)=>(n.fill ?? n.stroke)==='$text'));
});
