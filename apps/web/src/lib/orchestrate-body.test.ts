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

test('49. buildOrchestrateBody: attachments 未指定/空配列なら 1.27 以前と完全同形（キー無し）', () => {
  const bodyUndefined = buildOrchestrateBody('本文');
  assert.deepEqual(JSON.parse(bodyUndefined), { content: '本文' });
  const bodyEmpty = buildOrchestrateBody('本文', undefined, undefined, []);
  assert.deepEqual(JSON.parse(bodyEmpty), { content: '本文' });
});

test('50. buildOrchestrateBody: attachments 指定時は順序を保ったまま attachments キーのみ増える', () => {
  const attachments = [
    { filename: 'a.txt', mimeType: 'text/plain', content: 'YQ==' },
    { filename: 'b.md', mimeType: 'text/markdown', content: 'Yg==' },
  ];
  const body = buildOrchestrateBody('本文', undefined, undefined, attachments);
  const parsed = JSON.parse(body);
  assert.deepEqual(Object.keys(parsed), ['content', 'attachments']);
  assert.deepEqual(parsed.attachments, attachments);
});
