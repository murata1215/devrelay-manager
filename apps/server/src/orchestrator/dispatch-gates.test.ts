import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approveTarget, approvePlan, retryStale, cancelDispatch } from './dispatch-gates.js';
import type { GateCoreClient } from './dispatch-gates.js';
import type { DispatchClient } from './dispatch-store.js';

interface StubCalls {
  updateMany: Array<{ where: { id: string; status: string }; data: Record<string, unknown> }>;
  findUnique: Array<{ where: { id: string } }>;
}

function createStubClient(): { client: DispatchClient; calls: StubCalls } {
  const calls: StubCalls = { updateMany: [], findUnique: [] };
  const client: DispatchClient = {
    async updateMany(args) {
      calls.updateMany.push(args);
      return { count: 1 };
    },
    async findUnique(args) {
      calls.findUnique.push(args);
      return null;
    },
  };
  return { client, calls };
}

function stubCore(overrides: Partial<GateCoreClient>): GateCoreClient {
  return {
    async listProjects() {
      if (overrides.listProjects) return overrides.listProjects();
      throw new Error('listProjects は呼ばれない想定です');
    },
    async getPlan(submissionId) {
      if (overrides.getPlan) return overrides.getPlan(submissionId);
      throw new Error('getPlan は呼ばれない想定です');
    },
  };
}

test('63. approveTarget: freshCheck NG（projectId が list_projects に無い）は遷移せず理由を返す', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async listProjects() { return [{ id: 'other_project' }]; } });
  const result = await approveTarget({ client, core }, { id: 'd1', projectId: 'proj_x', instruction: 'x' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.reason, /freshCheck/);
  }
  assert.equal(calls.updateMany.length, 0); // draft のまま = DBに触らない
});

test('64. approveTarget: freshCheck OK なら draft -> submitting、instruction が同梱される', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async listProjects() { return [{ id: 'proj_x' }]; } });
  const result = await approveTarget({ client, core }, { id: 'd1', projectId: 'proj_x', instruction: '対象repoにXを実装して' });
  assert.equal(result.ok, true);
  assert.equal(calls.updateMany.length, 1);
  assert.deepEqual(calls.updateMany[0].where, { id: 'd1', status: 'draft' });
  assert.equal(calls.updateMany[0].data.status, 'submitting');
  assert.equal(calls.updateMany[0].data.instruction, '対象repoにXを実装して');
});

test('65. approvePlan: staleCheck が not_found を返したら awaiting_approval -> stale', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async getPlan() { return { status: 'not_found', error: 'Submission not found' }; } });
  const result = await approvePlan({ client, core }, { id: 'd1', submissionId: 's1' });
  assert.equal(result.outcome, 'stale');
  assert.equal(calls.updateMany[0].data.status, 'stale');
});

test('66. approvePlan: ready なら awaiting_approval -> approving', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async getPlan() { return { status: 'ready', planMarkdown: '# plan' }; } });
  const result = await approvePlan({ client, core }, { id: 'd1', submissionId: 's1' });
  assert.equal(result.outcome, 'approved');
  assert.equal(calls.updateMany[0].data.status, 'approving');
});

test('67. approvePlan: pending（plan未確定）なら遷移せず pending を返す', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async getPlan() { return { status: 'planning' }; } });
  const result = await approvePlan({ client, core }, { id: 'd1', submissionId: 's1' });
  assert.equal(result.outcome, 'pending');
  assert.equal(calls.updateMany.length, 0);
});

test('68. retryStale: 生存していれば stale -> planning、submissionId 同梱', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async getPlan() { return { status: 'ready', planMarkdown: '# plan' }; } });
  const result = await retryStale({ client, core }, { id: 'd1', submissionId: 's1' });
  assert.equal(result.outcome, 'planning');
  assert.equal(calls.updateMany[0].data.status, 'planning');
  assert.equal(calls.updateMany[0].data.submissionId, 's1');
});

test('69. retryStale: not_found なら stale -> draft、submissionId: null が同梱される', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async getPlan() { return { status: 'not_found' }; } });
  const result = await retryStale({ client, core }, { id: 'd1', submissionId: 's1' });
  assert.equal(result.outcome, 'draft');
  assert.equal(calls.updateMany[0].data.status, 'draft');
  assert.equal(calls.updateMany[0].data.submissionId, null);
});

test('70. cancelDispatch: 任意の非終端状態から stopped へ、理由が保存される', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({});
  await cancelDispatch({ client, core }, { id: 'd1', from: 'building', reason: '人間がキャンセルした' });
  assert.equal(calls.updateMany[0].where.status, 'building');
  assert.equal(calls.updateMany[0].data.status, 'stopped');
  assert.equal(calls.updateMany[0].data.statusReason, '人間がキャンセルした');
});
