import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTimeline } from './timeline.js';
import type { MessageDto, DispatchDto } from '../types.js';

/** テスト用の最小メッセージを作る。 */
function msg(id: string, createdAt: string): MessageDto {
  return { id, threadId: 't1', role: 'user', content: 'hello', createdAt, tier: null, model: null };
}

/** テスト用の最小 Dispatch を作る。 */
function dispatch(id: string, createdAt: string, status = 'draft'): DispatchDto {
  return {
    id,
    threadId: 't1',
    messageId: null,
    projectId: 'p1',
    instruction: null,
    submissionId: null,
    buildId: null,
    status,
    statusChangedAt: createdAt,
    statusReason: null,
    lastPolledAt: null,
    devlogPath: null,
    approveNote: null,
    council: false,
    cost: null,
    tier: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    responseModel: null,
    createdAt,
    updatedAt: createdAt,
  };
}

test('1. messages と dispatches が createdAt 昇順で正しく混ざる', () => {
  const messages = [msg('m2', '2026-08-28T10:02:00.000Z'), msg('m1', '2026-08-28T10:00:00.000Z')];
  const dispatches = [dispatch('d1', '2026-08-28T10:01:00.000Z')];
  const result = buildTimeline(messages, dispatches);
  assert.deepEqual(
    result.map((i) => i.id),
    ['m1', 'd1', 'm2']
  );
});

test('2. 同一 createdAt は message が dispatch より先に並ぶ', () => {
  const messages = [msg('m1', '2026-08-28T10:00:00.000Z')];
  const dispatches = [dispatch('d1', '2026-08-28T10:00:00.000Z')];
  const result = buildTimeline(messages, dispatches);
  assert.deepEqual(
    result.map((i) => i.kind),
    ['message', 'dispatch']
  );
});

test('3. 片方が空配列でも落ちず他方をそのまま返す', () => {
  const messages = [msg('m1', '2026-08-28T10:00:00.000Z')];
  const result = buildTimeline(messages, []);
  assert.equal(result.length, 1);
  assert.equal(result[0].kind, 'message');

  const dispatches = [dispatch('d1', '2026-08-28T10:00:00.000Z')];
  const result2 = buildTimeline([], dispatches);
  assert.equal(result2.length, 1);
  assert.equal(result2[0].kind, 'dispatch');
});

test('4. 両方空なら空配列', () => {
  assert.deepEqual(buildTimeline([], []), []);
});

test('5. 同一 createdAt かつ同種の場合は id の文字列比較で安定化する', () => {
  const messages = [msg('mZ', '2026-08-28T10:00:00.000Z'), msg('mA', '2026-08-28T10:00:00.000Z')];
  const result = buildTimeline(messages, []);
  assert.deepEqual(
    result.map((i) => i.id),
    ['mA', 'mZ']
  );
});
