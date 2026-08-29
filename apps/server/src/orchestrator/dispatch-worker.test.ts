import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tick, reconcileOrphans } from './dispatch-worker.js';
import type { WorkerCoreClient } from './dispatch-worker.js';
import type { DispatchQueryClient, DispatchListRow } from './dispatch-store.js';

interface StubCalls {
  findMany: Array<{ where: Record<string, unknown>; orderBy: Array<Record<string, unknown>>; take: number }>;
  updateMany: Array<{ where: { id: string; status: string }; data: Record<string, unknown> }>;
  findUnique: Array<{ where: { id: string } }>;
}

function createStubQueryClient(options: {
  rows?: DispatchListRow[];
  updateManyCount?: (data: Record<string, unknown>) => number;
} = {}): { client: DispatchQueryClient; calls: StubCalls } {
  const calls: StubCalls = { findMany: [], updateMany: [], findUnique: [] };
  const client: DispatchQueryClient = {
    async findMany(args) {
      calls.findMany.push(args);
      return options.rows ?? [];
    },
    async updateMany(args) {
      calls.updateMany.push(args);
      const count = options.updateManyCount ? options.updateManyCount(args.data) : 1;
      return { count };
    },
    async findUnique(args) {
      calls.findUnique.push(args);
      return null;
    },
  };
  return { client, calls };
}

function createStubCore(overrides: Partial<WorkerCoreClient> = {}): {
  core: WorkerCoreClient;
  calls: Record<string, unknown[]>;
} {
  const calls: Record<string, unknown[]> = {
    submitInstruction: [],
    getPlan: [],
    approveImplementation: [],
    getBuildStatus: [],
  };
  const core: WorkerCoreClient = {
    async submitInstruction(projectId, instruction, council) {
      calls.submitInstruction.push([projectId, instruction, council]);
      if (overrides.submitInstruction) return overrides.submitInstruction(projectId, instruction, council);
      throw new Error('submitInstruction は呼ばれない想定のテストです');
    },
    async getPlan(submissionId) {
      calls.getPlan.push([submissionId]);
      if (overrides.getPlan) return overrides.getPlan(submissionId);
      throw new Error('getPlan は呼ばれない想定のテストです');
    },
    async approveImplementation(projectId, submissionId, note) {
      calls.approveImplementation.push([projectId, submissionId, note]);
      if (overrides.approveImplementation) return overrides.approveImplementation(projectId, submissionId, note);
      throw new Error('approveImplementation は呼ばれない想定のテストです');
    },
    async getBuildStatus(submissionId) {
      calls.getBuildStatus.push([submissionId]);
      if (overrides.getBuildStatus) return overrides.getBuildStatus(submissionId);
      throw new Error('getBuildStatus は呼ばれない想定のテストです');
    },
  };
  return { core, calls };
}

function row(overrides: Partial<DispatchListRow>): DispatchListRow {
  return {
    id: 'd1',
    status: 'planning',
    statusChangedAt: new Date('2026-08-25T00:00:00Z'),
    lastPolledAt: null,
    submissionId: null,
    buildId: null,
    projectId: 'proj_1',
    instruction: null,
    approveNote: null,
    council: false,
    ...overrides,
  };
}

test('50. tick: 対象 status は表から導出される（人間ゲート・終端は一度も問い合わせない）', async () => {
  const { client, calls } = createStubQueryClient({ rows: [] });
  const { core } = createStubCore();
  await tick({ client, core, now: () => new Date('2026-08-25T00:00:00Z') });
  assert.equal(calls.findMany.length, 1);
  const statuses = (calls.findMany[0].where as { status: { in: string[] } }).status.in;
  for (const forbidden of ['draft', 'awaiting_approval', 'stale', 'done', 'failed', 'stopped']) {
    assert.ok(!statuses.includes(forbidden), `${forbidden} が対象 status に含まれてはいけない`);
  }
  assert.deepEqual(statuses.sort(), ['approving', 'building', 'planning', 'submitting'].sort());
});

test('51. tick: at-most-once 状態で lastPolledAt 非null の行は RPC を打たず claim もしない', async () => {
  const r = row({ status: 'submitting', instruction: 'x', lastPolledAt: new Date('2026-08-25T00:00:00Z') });
  const { client, calls } = createStubQueryClient({ rows: [r] });
  const { core, calls: coreCalls } = createStubCore();
  const report = await tick({ client, core, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.equal(calls.updateMany.length, 0);
  assert.equal(coreCalls.submitInstruction.length, 0);
  assert.equal(report.rows[0].outcome, 'skipped');
});

test('52. tick: claim 敗北時は RPC が0回', async () => {
  const r = row({ status: 'planning', submissionId: 's1' });
  const { client } = createStubQueryClient({
    rows: [r],
    updateManyCount: () => 0, // claim も CAS も全敗させる
  });
  const { core, calls: coreCalls } = createStubCore();
  const report = await tick({ client, core, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.equal(coreCalls.getPlan.length, 0);
  assert.equal(report.rows[0].outcome, 'skipped');
});

test('53. tick: submitInstruction 成功で submitting -> planning、submissionId が同一 data に入る', async () => {
  const r = row({ status: 'submitting', instruction: '対象repoにXを実装して', lastPolledAt: null });
  const { client, calls } = createStubQueryClient({ rows: [r] });
  const { core } = createStubCore({
    async submitInstruction() {
      return { submissionId: 'sub_new' };
    },
  });
  const report = await tick({ client, core, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.equal(report.rows[0].outcome, 'transitioned');
  const transitionCall = calls.updateMany.find((c) => 'status' in c.data);
  assert.ok(transitionCall);
  assert.equal(transitionCall!.data.status, 'planning');
  assert.equal(transitionCall!.data.submissionId, 'sub_new');
});

test('54. tick: getPlan が ready なら planning -> awaiting_approval、submissionId 同梱', async () => {
  const r = row({ status: 'planning', submissionId: 's1' });
  const { client, calls } = createStubQueryClient({ rows: [r] });
  const { core } = createStubCore({
    async getPlan() {
      return { status: 'ready', planMarkdown: '# plan' };
    },
  });
  const report = await tick({ client, core, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.equal(report.rows[0].outcome, 'transitioned');
  const transitionCall = calls.updateMany.find((c) => 'status' in c.data);
  assert.equal(transitionCall!.data.status, 'awaiting_approval');
  assert.equal(transitionCall!.data.submissionId, 's1');
});

test('55. tick: approveImplementation 成功で approving -> building', async () => {
  const r = row({ status: 'approving', submissionId: 's1' });
  const { client, calls } = createStubQueryClient({ rows: [r] });
  const { core } = createStubCore({
    async approveImplementation() {
      return { phase: 'building' };
    },
  });
  const report = await tick({ client, core, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.equal(report.rows[0].outcome, 'transitioned');
  const transitionCall = calls.updateMany.find((c) => 'status' in c.data);
  assert.equal(transitionCall!.data.status, 'building');
});

test('56. tick: getBuildStatus が succeeded なら building -> done、buildId が data に入る', async () => {
  const r = row({ status: 'building', submissionId: 's1' });
  const { client, calls } = createStubQueryClient({ rows: [r] });
  const { core } = createStubCore({
    async getBuildStatus() {
      return { done: true, phase: 'succeeded', buildId: 'build_9' };
    },
  });
  const report = await tick({ client, core, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.equal(report.rows[0].outcome, 'transitioned');
  const transitionCall = calls.updateMany.find((c) => 'status' in c.data);
  assert.equal(transitionCall!.data.status, 'done');
  assert.equal(transitionCall!.data.buildId, 'build_9');
});

test('57. tick: pending/unknown な応答では遷移しない（claim 以外の追加 updateMany が発生しない）', async () => {
  const r1 = row({ id: 'd1', status: 'planning', submissionId: 's1' });
  const { client: client1, calls: calls1 } = createStubQueryClient({ rows: [r1] });
  const { core: core1 } = createStubCore({
    async getPlan() {
      return { status: 'planning' }; // pending
    },
  });
  const report1 = await tick({ client: client1, core: core1, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.equal(report1.rows[0].outcome, 'noted');
  assert.equal(calls1.updateMany.length, 1); // claim のみ

  const r2 = row({ id: 'd2', status: 'building', submissionId: 's2' });
  const { client: client2, calls: calls2 } = createStubQueryClient({ rows: [r2] });
  const { core: core2 } = createStubCore({
    async getBuildStatus() {
      return { done: true, phase: 'mystery' }; // unknown
    },
  });
  const report2 = await tick({ client: client2, core: core2, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.equal(report2.rows[0].outcome, 'noted');
  assert.equal(calls2.updateMany.length, 1); // claim のみ
});

test('58. tick: ポーリングバジェット枯渇（既にポーリング済み）は RPC を打たず stopped', async () => {
  const statusChangedAt = new Date('2026-08-25T00:00:00Z');
  const r = row({
    status: 'planning',
    submissionId: 's1',
    statusChangedAt,
    lastPolledAt: new Date(statusChangedAt.getTime() + 5 * 60_000), // 既に1回ポーリング済み
  });
  const { client, calls } = createStubQueryClient({ rows: [r] });
  const { core, calls: coreCalls } = createStubCore();
  const now = new Date(statusChangedAt.getTime() + 31 * 60_000); // 30分バジェット超過
  const report = await tick({ client, core, now: () => now });
  assert.equal(coreCalls.getPlan.length, 0); // RPC を打っていない
  assert.equal(report.rows[0].outcome, 'transitioned');
  assert.equal(calls.updateMany[0].data.status, 'stopped');
  assert.match(calls.updateMany[0].data.statusReason as string, /バジェット/);
});

test('59. tick: 1行の例外が他行の処理を止めない', async () => {
  const r1 = row({ id: 'd1', status: 'planning', submissionId: 's1' });
  const r2 = row({ id: 'd2', status: 'building', submissionId: 's2' });
  const { client, calls } = createStubQueryClient({ rows: [r1, r2] });
  const { core } = createStubCore({
    async getPlan() {
      throw new Error('core が落ちている');
    },
    async getBuildStatus() {
      return { done: true, phase: 'succeeded', buildId: 'b2' };
    },
  });
  const report = await tick({ client, core, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.equal(report.rows.length, 2);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].id, 'd1');
  const row2Outcome = report.rows.find((x) => x.id === 'd2');
  assert.equal(row2Outcome!.outcome, 'transitioned');
  const transitionCall = calls.updateMany.find((c) => c.where.id === 'd2' && 'status' in c.data);
  assert.equal(transitionCall!.data.status, 'done');
});

test('60. reconcileOrphans: 猶予10分の cutoff を where に渡し、対象行を stopped にする', async () => {
  const now = new Date('2026-08-25T01:00:00Z');
  const orphan = row({
    id: 'orphan1',
    status: 'submitting',
    instruction: 'x',
    lastPolledAt: new Date(now.getTime() - 15 * 60_000), // 猶予10分を超過
  });
  const { client, calls } = createStubQueryClient({ rows: [orphan] });
  const report = await reconcileOrphans({ client, now: () => now });

  const findManyArgs = calls.findMany[0];
  const where = findManyArgs.where as { lastPolledAt: { lt: Date } };
  const expectedCutoff = new Date(now.getTime() - 10 * 60_000);
  assert.equal(where.lastPolledAt.lt.getTime(), expectedCutoff.getTime());

  assert.equal(report.transitioned, 1);
  const stopCall = calls.updateMany.find((c) => c.where.id === 'orphan1');
  assert.equal(stopCall!.data.status, 'stopped');
  assert.match(stopCall!.data.statusReason as string, /孤児回収/);
});

test('61. reconcileOrphans: graceMinutes を変えると cutoff がそれに応じて変わる', async () => {
  const now = new Date('2026-08-25T01:00:00Z');
  const { client, calls } = createStubQueryClient({ rows: [] });
  await reconcileOrphans({ client, now: () => now, graceMinutes: 20 });
  const where = calls.findMany[0].where as { lastPolledAt: { lt: Date } };
  assert.equal(where.lastPolledAt.lt.getTime(), now.getTime() - 20 * 60_000);
});

test('62. tick: findActionableDispatches の orderBy に lastPolledAt が含まれる（飢餓回帰）', async () => {
  const { client, calls } = createStubQueryClient({ rows: [] });
  const { core } = createStubCore();
  await tick({ client, core, now: () => new Date('2026-08-25T00:00:00Z') });
  const orderBy = calls.findMany[0].orderBy as Array<Record<string, unknown>>;
  const hasLastPolledAtFirst = orderBy.some((entry) => 'lastPolledAt' in entry);
  assert.ok(hasLastPolledAtFirst, 'orderBy に lastPolledAt が含まれていない（飢餓バグの回帰）');
  // lastPolledAt が statusChangedAt より先（配列の早い位置）にあること
  const lastPolledAtIndex = orderBy.findIndex((entry) => 'lastPolledAt' in entry);
  const statusChangedAtIndex = orderBy.findIndex((entry) => 'statusChangedAt' in entry);
  assert.ok(lastPolledAtIndex < statusChangedAtIndex);
});

// ── サイクル1.19 S3: approveImplementation への note 伝播 ────────────────────

test('155. tick: row.approveNote があれば approveImplementation の第3引数に渡る', async () => {
  const r = row({ status: 'approving', submissionId: 's1', approveNote: '案Bで進めてください' });
  const { client } = createStubQueryClient({ rows: [r] });
  const { core, calls: coreCalls } = createStubCore({
    async approveImplementation() {
      return { phase: 'building' };
    },
  });
  await tick({ client, core, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.deepEqual(coreCalls.approveImplementation[0], ['proj_1', 's1', '案Bで進めてください']);
});

test('156. tick: row.approveNote が null なら approveImplementation の第3引数は undefined（現行と同形）', async () => {
  const r = row({ status: 'approving', submissionId: 's1', approveNote: null });
  const { client } = createStubQueryClient({ rows: [r] });
  const { core, calls: coreCalls } = createStubCore({
    async approveImplementation() {
      return { phase: 'building' };
    },
  });
  await tick({ client, core, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.deepEqual(coreCalls.approveImplementation[0], ['proj_1', 's1', undefined]);
});

// ── サイクル1.19 S5: devlogPath の取りこぼし修正 ─────────────────────────────

test('159. tick: getBuildStatus が devlogPath を返せば building -> done の patch に devlogPath が入る', async () => {
  const r = row({ status: 'building', submissionId: 's1' });
  const { client, calls } = createStubQueryClient({ rows: [r] });
  const { core } = createStubCore({
    async getBuildStatus() {
      return { done: true, phase: 'succeeded', buildId: 'build_9', devlogPath: 'doc/devlog/x.md' };
    },
  });
  const report = await tick({ client, core, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.equal(report.rows[0].outcome, 'transitioned');
  const transitionCall = calls.updateMany.find((c) => 'status' in c.data);
  assert.equal(transitionCall!.data.status, 'done');
  assert.equal(transitionCall!.data.devlogPath, 'doc/devlog/x.md');
});

// ── サイクル1.21: council 結線 ────────────────────────────────────────────

test('165. tick: row.council=false は submitInstruction 第3引数が undefined、true は true', async () => {
  const rOff = row({ id: 'd1', status: 'submitting', instruction: 'x', council: false });
  const { client: clientOff } = createStubQueryClient({ rows: [rOff] });
  const { core: coreOff, calls: coreCallsOff } = createStubCore({
    async submitInstruction() {
      return { submissionId: 'sub_off' };
    },
  });
  await tick({ client: clientOff, core: coreOff, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.deepEqual(coreCallsOff.submitInstruction[0], ['proj_1', 'x', undefined]);

  const rOn = row({ id: 'd2', status: 'submitting', instruction: 'y', council: true });
  const { client: clientOn } = createStubQueryClient({ rows: [rOn] });
  const { core: coreOn, calls: coreCallsOn } = createStubCore({
    async submitInstruction() {
      return { submissionId: 'sub_on' };
    },
  });
  await tick({ client: clientOn, core: coreOn, now: () => new Date('2026-08-25T00:01:00Z') });
  assert.deepEqual(coreCallsOn.submitInstruction[0], ['proj_1', 'y', true]);
});
