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

test('comment composer keeps the send button without a Return chip', () => {
  const source = fs.readFileSync(new URL('../src/page/comments.js', import.meta.url), 'utf8');
  const composer = source.slice(source.indexOf('function startDraft('), source.indexOf('comp.append(fieldRow, foot)'));
  assert.ok(composer.includes('sendBtn("Post comment"'));
  assert.ok(!composer.includes('"cm-key"'));
  assert.ok(!source.includes('ICON.ret'));
  assert.ok(source.includes('e.key === "Enter" && !e.shiftKey && !e.isComposing'));
});
