import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DISPATCH_STATUSES,
  DISPATCH_STATES,
  canTransition,
  assertTransition,
  allowedTransitionsFrom,
  isTerminal,
  awaitsHuman,
  nextActionFor,
  requiredFieldsFor,
  parseDispatchStatus,
} from './dispatch-state.js';
import type { DispatchStatus } from './dispatch-state.js';

const ALL_STATUSES = DISPATCH_STATUSES as readonly DispatchStatus[];

// spec (doc/orchestrator-layer3-design.md §2) が定める、独立に書き下した期待遷移表。
// dispatch-state.ts の DISPATCH_STATES 本体とは別に手で書くことで、実装の
// うっかり編集ミスを検出できるようにする（テスト8で使用）。
const EXPECTED_TRANSITIONS: Record<DispatchStatus, DispatchStatus[]> = {
  draft: ['submitting', 'stopped'],
  submitting: ['planning', 'stopped'],
  planning: ['awaiting_approval', 'failed', 'stopped'],
  awaiting_approval: ['approving', 'stale', 'stopped'],
  stale: ['planning', 'draft', 'stopped'],
  approving: ['building', 'stopped'],
  building: ['done', 'failed', 'stopped'],
  done: [],
  failed: [],
  stopped: [],
};

test('1. DISPATCH_STATUSES と DISPATCH_STATES のキーが完全一致する', () => {
  const stateKeys = Object.keys(DISPATCH_STATES).sort();
  const statusList = [...ALL_STATUSES].sort();
  assert.deepEqual(stateKeys, statusList);
});

test('2. 全遷移先が有効な status である（ぶら下がり辺ゼロ）', () => {
  for (const status of ALL_STATUSES) {
    for (const to of allowedTransitionsFrom(status)) {
      assert.ok(
        ALL_STATUSES.includes(to),
        `"${status}" -> "${to}" は未知の状態を指している`
      );
    }
  }
});

test('3. 全状態で isTerminal(s) === (allowed(s).length === 0)', () => {
  for (const status of ALL_STATUSES) {
    assert.equal(isTerminal(status), allowedTransitionsFrom(status).length === 0);
  }
});

test('4. 終端はちょうど {done, failed, stopped}', () => {
  const terminals = ALL_STATUSES.filter(isTerminal).sort();
  assert.deepEqual(terminals, ['done', 'failed', 'stopped']);
});

test('5. 全非終端状態から終端状態へ到達可能（BFS）', () => {
  for (const start of ALL_STATUSES) {
    if (isTerminal(start)) continue;
    const visited = new Set<DispatchStatus>([start]);
    const queue: DispatchStatus[] = [start];
    let reachedTerminal = false;
    while (queue.length > 0) {
      const current = queue.shift() as DispatchStatus;
      if (isTerminal(current)) {
        reachedTerminal = true;
        break;
      }
      for (const next of allowedTransitionsFrom(current)) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }
    assert.ok(reachedTerminal, `"${start}" から終端状態へ到達できない`);
  }
});

test('6. 全非終端状態が -> stopped を許可する（人間はいつでもキャンセル可能）', () => {
  for (const status of ALL_STATUSES) {
    if (isTerminal(status)) continue;
    assert.ok(
      canTransition(status, 'stopped'),
      `"${status}" から "stopped" への遷移が許可されていない`
    );
  }
});

test('7. 状態集合が spec §2 の10値と完全一致し、"pending" が不在', () => {
  const expected = [
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
  ].sort();
  assert.deepEqual([...ALL_STATUSES].sort(), expected);
  assert.ok(!(ALL_STATUSES as readonly string[]).includes('pending'));
});

test('8. 10x10 canTransition 全マトリクスが独立に書いた期待表と一致する', () => {
  for (const from of ALL_STATUSES) {
    for (const to of ALL_STATUSES) {
      const expected = EXPECTED_TRANSITIONS[from].includes(to);
      assert.equal(
        canTransition(from, to),
        expected,
        `canTransition("${from}", "${to}") should be ${expected}`
      );
    }
  }
});

test('9. assertTransition は不正遷移で throw し、メッセージに現在/要求/許可一覧を含む', () => {
  assert.throws(
    () => assertTransition('done', 'building'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /done/);
      assert.match(err.message, /building/);
      assert.match(err.message, /終端状態のため遷移不可/);
      return true;
    }
  );

  assert.throws(
    () => assertTransition('draft', 'building'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /draft/);
      assert.match(err.message, /building/);
      // 許可される遷移先一覧（submitting, stopped）が含まれる
      assert.match(err.message, /submitting/);
      assert.match(err.message, /stopped/);
      return true;
    }
  );

  // 正当な遷移は throw しない
  assert.doesNotThrow(() => assertTransition('draft', 'submitting'));
});

test('10. parseDispatchStatus("pending") は値名付きで throw する', () => {
  assert.throws(
    () => parseDispatchStatus('pending'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /pending/);
      return true;
    }
  );
  // 有効な値は素通しする
  assert.equal(parseDispatchStatus('draft'), 'draft');
});

test('11. nextActionFor(s) === null は awaitsHuman(s) || isTerminal(s) と同値', () => {
  for (const status of ALL_STATUSES) {
    const hasNoNextAction = nextActionFor(status) === null;
    const expected = awaitsHuman(status) || isTerminal(status);
    assert.equal(hasNoNextAction, expected, `state=${status}`);
  }
});

test('12. submitting/approving は at-most-once、planning/building は idempotent', () => {
  assert.equal(nextActionFor('submitting')?.retry, 'at-most-once');
  assert.equal(nextActionFor('approving')?.retry, 'at-most-once');
  assert.equal(nextActionFor('planning')?.retry, 'idempotent');
  assert.equal(nextActionFor('building')?.retry, 'idempotent');
});

test('13. requiredFieldsFor は不変条件表どおり（building は buildId を要求しない）', () => {
  assert.deepEqual(requiredFieldsFor('draft'), []);
  assert.deepEqual(requiredFieldsFor('submitting'), ['instruction']);
  assert.deepEqual(requiredFieldsFor('planning'), ['submissionId']);
  assert.deepEqual(requiredFieldsFor('awaiting_approval'), ['submissionId']);
  assert.deepEqual(requiredFieldsFor('stale'), ['submissionId']);
  assert.deepEqual(requiredFieldsFor('approving'), ['submissionId']);
  // building は submissionId のみを要求し、buildId は要求しない
  // （approve_implementation は {phase} のみ返し、buildId は get_build_status で
  //  初めて分かるため、承認直後の building 遷移で必須にすると必ず throw してしまう）
  assert.deepEqual(requiredFieldsFor('building'), ['submissionId']);
  assert.ok(!(requiredFieldsFor('building') as readonly string[]).includes('buildId'));
  assert.deepEqual(requiredFieldsFor('done'), []);
  assert.deepEqual(requiredFieldsFor('failed'), []);
  assert.deepEqual(requiredFieldsFor('stopped'), []);
});
