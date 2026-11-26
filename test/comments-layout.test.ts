import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
test('the comment mode hint allows descenders and content growth at 100% line height', () => {
  const source = fs.readFileSync(new URL('../src/page/comments.js', import.meta.url), 'utf8');
  const rule = (selector: string) => source.split('\n').find(line => line.startsWith(selector + '{')) || '';
  assert.ok(rule('.cm-hint').includes('min-height:36px'));
  assert.ok(!rule('.native .cm-hint .cm-soft').includes('overflow:hidden'));
  assert.ok(source.includes('font-size:13px;line-height:100%;pointer-events:none'));
});

test('comments have no floating toolbar and use one sidebar for threads and agent runs', () => {
  const comments = fs.readFileSync(new URL('../src/page/comments.js', import.meta.url), 'utf8');
  const conversations = fs.readFileSync(new URL('../src/page/conversations.js', import.meta.url), 'utf8');
  assert.ok(!comments.includes('.cm-bar'));
  assert.ok(comments.includes('cm-sidebar right-sidebar'));
  assert.ok(!conversations.includes('cv-sidebar'));
});

test('comment composer keeps the send button without a Return chip', () => {
  const source = fs.readFileSync(new URL('../src/page/comments.js', import.meta.url), 'utf8');
  const composer = source.slice(source.indexOf('function startDraft('), source.indexOf('comp.append(fieldRow, foot)'));
  assert.ok(composer.includes('sendBtn("Post comment"'));
  assert.ok(!composer.includes('"cm-key"'));
  assert.ok(!source.includes('ICON.ret'));
  assert.ok(source.includes('e.key === "Enter" && !e.shiftKey && !e.isComposing'));
});

test('agent comments show a filled sparkles mark, not an outline', () => {
  const source = fs.readFileSync(new URL('../src/page/comments.js', import.meta.url), 'utf8');
  const line = source.split('\n').find(l => l.trim().startsWith('sparkles:')) || '';
  assert.ok(line.includes('fill="currentColor"') && line.includes('stroke="none"'));
});
