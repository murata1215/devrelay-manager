import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPATCH_STATUS_LABELS,
  isTerminalStatus,
  cardKindFor,
  canCancel,
  shouldPoll,
  doneRowsOf,
  approveNoteOf,
  councilBadgeOf,
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

test('19. doneRowsOf: null/undefined/空文字の項目は行ごと除外される', () => {
  const rows = doneRowsOf({
    submissionId: 'sub-1',
    buildId: null,
    devlogPath: '',
    inputTokens: 100,
    outputTokens: null,
    responseModel: 'claude-sonnet-5',
  });
  assert.deepEqual(
    rows.map((r) => r.label),
    ['submissionId', 'inputTokens', 'responseModel']
  );
});

test('20. doneRowsOf: 値のある項目のみラベルと文字列化した値で返す', () => {
  const rows = doneRowsOf({
    submissionId: 'sub-1',
    buildId: 'build-1',
    devlogPath: 'doc/devlog/a.md',
    inputTokens: 111,
    outputTokens: 222,
    responseModel: 'claude-sonnet-5',
  });
  assert.deepEqual(rows, [
    { label: 'submissionId', value: 'sub-1' },
    { label: 'buildId', value: 'build-1' },
    { label: 'devlogPath', value: 'doc/devlog/a.md' },
    { label: 'inputTokens', value: '111' },
    { label: 'outputTokens', value: '222' },
    { label: 'responseModel', value: 'claude-sonnet-5' },
  ]);
});

test('24. approveNoteOf: null/空文字/空白のみはすべて null を返す', () => {
  assert.equal(approveNoteOf({ approveNote: null }), null);
  assert.equal(approveNoteOf({ approveNote: '' }), null);
  assert.equal(approveNoteOf({ approveNote: '   ' }), null);
});

test('25. approveNoteOf: 値がある場合は trim 済み文字列を返す', () => {
  assert.equal(approveNoteOf({ approveNote: '案B採用で進めてください' }), '案B採用で進めてください');
  assert.equal(approveNoteOf({ approveNote: '  前後に空白  ' }), '前後に空白');
});

test('29. councilBadgeOf: false/null/undefined は null、true は "council" を返す', () => {
  assert.equal(councilBadgeOf({ council: false }), null);
  assert.equal(councilBadgeOf({ council: null }), null);
  assert.equal(councilBadgeOf({ council: undefined }), null);
  assert.equal(councilBadgeOf({}), null);
  assert.equal(councilBadgeOf({ council: true }), 'council');
});
