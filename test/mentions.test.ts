import assert from 'node:assert/strict';
import { test } from 'node:test';
// @ts-ignore browser module
import { mentionQuery, mentionPeople, mentionTokens, mentionedYou } from '../src/page/mentions.js';
import { applyOp, checkEnvelope, type Thread } from '../cloud/protocol.ts';
import { randomUUID } from 'node:crypto';

test('mention trigger, filtering and plain text token ranges', () => {
  assert.equal(mentionQuery('anna@studio.test', 9), null);
  assert.deepEqual(mentionQuery('@', 1), { start: 0, end: 1, query: '' });
  assert.deepEqual(mentionQuery('Again @', 7), { start: 6, end: 7, query: '' });
  assert.deepEqual(mentionQuery('Hi @be', 6), { start: 3, end: 6, query: 'be' });
  const ben = { name: 'Ben', email: 'ben@studio.test' };
  assert.deepEqual(mentionPeople([ben, ben, { name: 'Anna' }], 'BE'), [ben]);
  assert.deepEqual(mentionTokens('Hi @Ben again', [ben]), [{ start: 3, end: 7, ...ben }]);
  assert.deepEqual(mentionTokens('@Benny', [ben]), []);
});
test('mention tokens survive comment storage and edits clear old tokens', () => {
  const threads: Thread[] = [], thread = randomUUID(), comment = randomUUID(), doc = randomUUID();
  const mentions = [{ start: 0, end: 4, name: 'Ben', email: 'ben@studio.test' }];
  const op = { kind: 'thread.create' as const, thread, comment, anchor: { x: 0, y: 0 }, body: '@Ben please check', mentions };
  assert.equal(checkEnvelope({ opId: randomUUID(), doc, at: new Date().toISOString(), op }), null);
  assert.equal(applyOp(threads, doc, op, { name: 'Anna' }, new Date().toISOString()), null);
  const saved = JSON.parse(JSON.stringify(threads))[0].comments[0];
  assert.deepEqual(saved.mentions, mentions);
  assert.equal(saved.body, '@Ben please check');
  assert.equal(mentionedYou(saved, { email: 'ben@studio.test' }), true);
  assert.equal(mentionedYou(saved, { email: 'anna@studio.test' }), false);
  assert.equal(checkEnvelope({ opId: randomUUID(), doc, at: '', op: { ...op, mentions: [{ ...mentions[0], end: 900 }] } }), 'invalid mentions');
  applyOp(threads, doc, { kind: 'comment.edit', comment, body: 'Changed' }, { name: 'Anna' }, '');
  assert.equal(threads[0].comments[0].mentions, undefined);
});
