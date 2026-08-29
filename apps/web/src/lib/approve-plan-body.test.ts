import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildApprovePlanBody } from './approve-plan-body.js';

test('21. buildApprovePlanBody: note 未指定なら 1.19 以前と同形の "{}" を返す', () => {
  assert.equal(buildApprovePlanBody(), '{}');
  assert.equal(buildApprovePlanBody(undefined), '{}');
});

test('22. buildApprovePlanBody: 空文字・空白のみでも "{}" を返す（空 note を送らない）', () => {
  assert.equal(buildApprovePlanBody(''), '{}');
  assert.equal(buildApprovePlanBody('   '), '{}');
  assert.equal(buildApprovePlanBody('\n\t '), '{}');
});

test('23. buildApprovePlanBody: note 指定時は trim 済みの note だけを持つ JSON を返す', () => {
  const body = buildApprovePlanBody('  案B採用で進めてください  ');
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed), ['note']);
  assert.equal(parsed.note, '案B採用で進めてください');
});
