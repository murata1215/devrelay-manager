import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPATCH_STATUS_LABELS,
  isTerminalStatus,
  cardKindFor,
  canCancel,
  shouldPoll,
} from './dispatch-status.js';

// apps/server/src/orchestrator/dispatch-state.ts の DISPATCH_STATUSES と
// 独立に手で書き下した期待値（10状態）。実装のうっかり編集ミスを検出する。
const ALL_STATUSES = [
  'draft',
  'submitting',
  'planning',
  'awaiting_approval',
  'stale',
  'approving',
  'building',
  'done',
  'failed',
  'stopped',
];

test('6. isTerminalStatus: done/failed/stopped のみ true、残り7状態は false', () => {
  const terminal = ALL_STATUSES.filter((s) => isTerminalStatus(s));
  assert.deepEqual(terminal.sort(), ['done', 'failed', 'stopped'].sort());
});

test('7. cardKindFor: 10状態すべてが期待どおりの kind に写る', () => {
  assert.equal(cardKindFor('draft'), 'draft');
  assert.equal(cardKindFor('awaiting_approval'), 'plan');
  assert.equal(cardKindFor('stale'), 'stale');
  assert.equal(cardKindFor('done'), 'done');
  for (const s of ['submitting', 'planning', 'approving', 'building', 'failed', 'stopped']) {
    assert.equal(cardKindFor(s), 'progress', `${s} は progress のはず`);
  }
});

test('8. 未知の status は unknown に落ち、isTerminalStatus は false', () => {
  assert.equal(cardKindFor('zzz'), 'unknown');
  assert.equal(isTerminalStatus('zzz'), false);
});

test('9. shouldPoll: 非終端が1件でも混ざれば true', () => {
  assert.equal(shouldPoll([{ status: 'done' }, { status: 'building' }]), true);
});

test('10. shouldPoll: 全件終端／空配列なら false', () => {
  assert.equal(shouldPoll([{ status: 'done' }, { status: 'failed' }]), false);
  assert.equal(shouldPoll([]), false);
});

test('11. DISPATCH_STATUS_LABELS が10状態すべてのキーを持つ', () => {
  assert.deepEqual(Object.keys(DISPATCH_STATUS_LABELS).sort(), [...ALL_STATUSES].sort());
});

test('12. canCancel: 非終端 true・終端 false', () => {
  assert.equal(canCancel('building'), true);
  assert.equal(canCancel('done'), false);
  assert.equal(canCancel('failed'), false);
  assert.equal(canCancel('stopped'), false);
});
