import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getRecipe } from '../mcp/recipe/index.ts';

test('recipe topics include taste, linked rules and checks, with ranges expanded', () => {
  for (const topic of ['feed','onboarding','permission','paywall','settings','profile','search','checkout','website','dashboard'] as const) {
    const r = getRecipe(topic);
    assert.match(r, /## Taste/);
    assert.match(r, /### 6\./);
    assert.match(r, /`R-7-/);
    assert.doesNotMatch(r, /Source:/);
  }
  assert.match(getRecipe('onboarding'), /`R-2-4`/);
  assert.doesNotMatch(getRecipe('permission'), /### 6.4 Paywall/);
  assert.doesNotMatch(getRecipe('taste'), /`R-1-1`/);
  assert.match(getRecipe('checks'), /`R-7-51`/);
  assert.match(getRecipe(), /### 6.10/);
});
test('every recipe topic retains the complete measured and design system sections',()=>{
 const all=getRecipe();
 const supporting=all.slice(all.indexOf('## 3.'),all.indexOf('## 5.'));
 for(const topic of ['feed','onboarding','permission','paywall','settings','profile','search','checkout','website','dashboard'] as const) {
  assert.ok(getRecipe(topic).includes(supporting),topic+' must include all supporting tables');
 }
});
