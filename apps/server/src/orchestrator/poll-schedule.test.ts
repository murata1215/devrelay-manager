import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  pollIntervalMsFor,
  isPollDue,
  budgetMinutesFor,
  isBudgetExhausted,
  POLL_INTERVALS_MINUTES,
  POLL_BUDGET_MINUTES,
} from './poll-schedule.js';

const MIN = 60_000;

test('23. pollIntervalMsFor: 経過0分は最初の間隔(2分)', () => {
  assert.equal(pollIntervalMsFor(0), 2 * MIN);
});

test('24. pollIntervalMsFor: 経過1分59秒はまだ2分間隔', () => {
  assert.equal(pollIntervalMsFor(1 * MIN + 59_000), 2 * MIN);
});

test('25. pollIntervalMsFor: 経過2分ちょうどで3分間隔に上がる', () => {
  assert.equal(pollIntervalMsFor(2 * MIN), 3 * MIN);
});

test('26. pollIntervalMsFor: 経過3分ちょうどで4分間隔に上がる', () => {
  assert.equal(pollIntervalMsFor(3 * MIN), 4 * MIN);
});

test('27. pollIntervalMsFor: 経過4分ちょうどで5分間隔に上がる', () => {
  assert.equal(pollIntervalMsFor(4 * MIN), 5 * MIN);
});

test('28. pollIntervalMsFor: 経過5分・10分・1時間はすべて5分で頭打ち', () => {
  assert.equal(pollIntervalMsFor(5 * MIN), 5 * MIN);
  assert.equal(pollIntervalMsFor(10 * MIN), 5 * MIN);
  assert.equal(pollIntervalMsFor(60 * MIN), 5 * MIN);
  assert.deepEqual(POLL_INTERVALS_MINUTES, [2, 3, 4, 5]);
});

test('29. isPollDue: lastPolledAt が null なら経過時間に関わらず true', () => {
  const now = new Date('2026-08-25T00:00:00Z');
  const statusChangedAt = new Date('2026-08-25T00:00:00Z');
  assert.equal(isPollDue(now, statusChangedAt, null), true);
});

test('30. isPollDue: 直前のポーリングから間隔未経過なら false', () => {
  const statusChangedAt = new Date('2026-08-25T00:00:00Z');
  const lastPolledAt = new Date('2026-08-25T00:00:00Z'); // 状態開始直後にポーリング済み
  const now = new Date(lastPolledAt.getTime() + 1 * MIN); // 2分間隔なのにまだ1分
  assert.equal(isPollDue(now, statusChangedAt, lastPolledAt), false);
});

test('31. isPollDue: 直前のポーリングから間隔ちょうど経過したら true', () => {
  const statusChangedAt = new Date('2026-08-25T00:00:00Z');
  const lastPolledAt = new Date('2026-08-25T00:00:00Z');
  const now = new Date(lastPolledAt.getTime() + 2 * MIN); // 経過0分時点の間隔=2分
  assert.equal(isPollDue(now, statusChangedAt, lastPolledAt), true);
});

test('32. budgetMinutesFor: idempotent 状態(planning/building)のみ値を持つ', () => {
  assert.equal(budgetMinutesFor('planning'), POLL_BUDGET_MINUTES.planning);
  assert.equal(budgetMinutesFor('building'), POLL_BUDGET_MINUTES.building);
  assert.equal(budgetMinutesFor('draft'), null);
  assert.equal(budgetMinutesFor('awaiting_approval'), null);
  assert.equal(budgetMinutesFor('stale'), null);
  assert.equal(budgetMinutesFor('submitting'), null); // at-most-once
  assert.equal(budgetMinutesFor('approving'), null); // at-most-once
  assert.equal(budgetMinutesFor('done'), null);
  assert.equal(budgetMinutesFor('failed'), null);
  assert.equal(budgetMinutesFor('stopped'), null);
});

test('33. isBudgetExhausted: planning は30分、building は120分で尽きる（境界含む）', () => {
  const statusChangedAt = new Date('2026-08-25T00:00:00Z');
  assert.equal(
    isBudgetExhausted(new Date(statusChangedAt.getTime() + 29 * MIN), statusChangedAt, 'planning'),
    false
  );
  assert.equal(
    isBudgetExhausted(new Date(statusChangedAt.getTime() + 30 * MIN), statusChangedAt, 'planning'),
    true
  );
  assert.equal(
    isBudgetExhausted(new Date(statusChangedAt.getTime() + 119 * MIN), statusChangedAt, 'building'),
    false
  );
  assert.equal(
    isBudgetExhausted(new Date(statusChangedAt.getTime() + 120 * MIN), statusChangedAt, 'building'),
    true
  );
  // 人間ゲート・at-most-once・終端にはバジェットが無いので何時間経っても false
  assert.equal(
    isBudgetExhausted(new Date(statusChangedAt.getTime() + 999 * MIN), statusChangedAt, 'awaiting_approval'),
    false
  );
  assert.equal(
    isBudgetExhausted(new Date(statusChangedAt.getTime() + 999 * MIN), statusChangedAt, 'submitting'),
    false
  );
});
