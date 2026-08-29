import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildOrchestrateBody } from './orchestrate-body.js';

test('26. buildOrchestrateBody: council/projectIds 未指定なら 1.21 以前と同形の {"content":...} を返す', () => {
  const body = buildOrchestrateBody('こんにちは');
  assert.deepEqual(JSON.parse(body), { content: 'こんにちは' });
});

test('27. buildOrchestrateBody: projectIds ありでも council false ならキーは content/projectIds のみ', () => {
  const body = buildOrchestrateBody('本文', ['p1', 'p2'], false);
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed), ['content', 'projectIds']);
  assert.deepEqual(parsed.projectIds, ['p1', 'p2']);
});

test('28. buildOrchestrateBody: council true のとき council: true が入る', () => {
  const body = buildOrchestrateBody('本文', undefined, true);
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed), ['content', 'council']);
  assert.equal(parsed.council, true);
});
