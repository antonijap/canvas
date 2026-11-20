import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
test('comment notices allow descenders and content growth at 100% line height', () => {
  const source = fs.readFileSync(new URL('../src/page/comments.js', import.meta.url), 'utf8');
  const rule = (selector: string) => source.split('\n').find(line => line.startsWith(selector + '{')) || '';
  assert.ok(rule('.cm-hint').includes('min-height:36px'));
  assert.ok(rule('.cm-bar').includes('min-height:36px'));
  assert.ok(!rule('.native .cm-hint .cm-soft').includes('overflow:hidden'));
  assert.ok(source.includes('font-size:13px;line-height:100%;pointer-events:none'));
});
