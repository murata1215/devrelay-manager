import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approveTarget,
  approvePlan,
  retryStale,
  cancelDispatch,
  approveTargetHttpStatus,
} from './dispatch-gates.js';
import type { GateCoreClient, ApproveTargetResult } from './dispatch-gates.js';
import type { DispatchClient } from './dispatch-store.js';
import { composeInstruction } from './governance.js';
import { loadManagerSettings } from './manager-settings.js';

/** サイクル1.15: ゲート①のgovernance再注入テスト用の Settings（governance.test.ts と同形）。 */
function settings() {
  return loadManagerSettings({
    version: 1,
    defaultTier: 'standard',
    tierModels: {
      heavy: { model: 'claude-opus-5', label: 'Heavy', idForm: 'pinned-dateless', note: 'test note heavy' },
      standard: { model: 'claude-sonnet-5', label: 'Standard', idForm: 'pinned-dateless', note: 'test note standard' },
      light: { model: 'claude-haiku-4-5-20251001', label: 'Light', idForm: 'pinned-dated', note: 'test note light' },
    },
    modelIdSource: {
      url: 'https://platform.claude.com/docs/en/about-claude/models/overview',
      checkedAt: '2026-08-26',
    },
    llm: { timeoutMs: 60000, maxTokens: 8192 },
    governance: {
      requiredClauses: ['AskUserQuestion禁止', 'devlog', 'STOP'],
      header: '===HEADER=== AskUserQuestion禁止\n',
      footer: '\n===FOOTER=== devlog STOP',
    },
  });
}

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
  const result = await approveTarget({ client, core, settings: settings() }, { id: 'd1', projectId: 'proj_x', instruction: 'x' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'fresh_check');
    assert.match(result.reason, /freshCheck/);
  }
  assert.equal(calls.updateMany.length, 0); // draft のまま = DBに触らない
});

test('64. approveTarget: freshCheck OK なら draft -> submitting、governance 適用済み全文が保存される', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async listProjects() { return [{ id: 'proj_x' }]; } });
  const s = settings();
  const result = await approveTarget({ client, core, settings: s }, { id: 'd1', projectId: 'proj_x', instruction: '対象repoにXを実装して' });
  assert.equal(result.ok, true);
  assert.equal(calls.updateMany.length, 1);
  assert.deepEqual(calls.updateMany[0].where, { id: 'd1', status: 'draft' });
  assert.equal(calls.updateMany[0].data.status, 'submitting');
  // サイクル1.15: 渡した生文字列がそのまま保存されるのではなく、composeInstruction による
  // governance 適用済み全文（draft 生成時と同じ関数の出力）が保存される。
  assert.equal(calls.updateMany[0].data.instruction, composeInstruction('対象repoにXを実装して', s));
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

test('124. approveTarget: governance を剥がした instruction を渡すと、保存文字列に必須句が復元される', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async listProjects() { return [{ id: 'proj_x' }]; } });
  const s = settings();
  // governance テンプレを含まない、素の本文だけを人間が送ってきたケース。
  const strippedBody = '対象repoにYを実装して（テンプレなし）';
  const result = await approveTarget({ client, core, settings: s }, { id: 'd1', projectId: 'proj_x', instruction: strippedBody });
  assert.equal(result.ok, true);
  const saved = calls.updateMany[0].data.instruction as string;
  for (const clause of s.governance.requiredClauses) {
    assert.ok(saved.includes(clause), `必須句が欠けています: ${clause}`);
  }
  assert.ok(saved.startsWith(s.governance.header));
  assert.ok(saved.endsWith(s.governance.footer));
});

test('125. approveTarget: draft の全文（合成済み）をそのまま渡すと、保存文字列が完全一致する（冪等の実地確認）', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async listProjects() { return [{ id: 'proj_x' }]; } });
  const s = settings();
  const draftInstruction = composeInstruction('対象repoにZを実装して', s);
  const result = await approveTarget({ client, core, settings: s }, { id: 'd1', projectId: 'proj_x', instruction: draftInstruction });
  assert.equal(result.ok, true);
  assert.equal(calls.updateMany[0].data.instruction, draftInstruction);
  if (result.ok) {
    assert.equal(result.instruction, draftInstruction);
  }
});

test('126. approveTarget: 人間が本文を書き換えた場合、書き換え後の本文が残り、かつ必須句も残る', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async listProjects() { return [{ id: 'proj_x' }]; } });
  const s = settings();
  const draftInstruction = composeInstruction('対象repoにAを実装して', s);
  // 人間が本文部分だけを書き換えた合成済み文字列を送るケース（header/footer は維持されたまま）。
  const edited = draftInstruction.replace('対象repoにAを実装して', '対象repoにBを実装して（人間が修正）');
  const result = await approveTarget({ client, core, settings: s }, { id: 'd1', projectId: 'proj_x', instruction: edited });
  assert.equal(result.ok, true);
  const saved = calls.updateMany[0].data.instruction as string;
  assert.ok(saved.includes('対象repoにBを実装して（人間が修正）'));
  for (const clause of s.governance.requiredClauses) {
    assert.ok(saved.includes(clause));
  }
});

test('127. approveTarget: 空白のみの instruction は ok:false/empty_instruction、無遷移・listProjects 未呼び出し', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({}); // listProjects は呼ばれたら throw する（未呼び出しの機械確認）
  const result = await approveTarget({ client, core, settings: settings() }, { id: 'd1', projectId: 'proj_x', instruction: '   \n\t' });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'empty_instruction');
  }
  assert.equal(calls.updateMany.length, 0);
});

test('128. approveTargetHttpStatus: empty_instruction->400, fresh_check->409, ok->200', () => {
  const okResult: ApproveTargetResult = { ok: true, instruction: 'x' };
  const emptyResult: ApproveTargetResult = { ok: false, code: 'empty_instruction', reason: 'r' };
  const freshResult: ApproveTargetResult = { ok: false, code: 'fresh_check', reason: 'r' };
  assert.equal(approveTargetHttpStatus(okResult), 200);
  assert.equal(approveTargetHttpStatus(emptyResult), 400);
  assert.equal(approveTargetHttpStatus(freshResult), 409);
});

// ── サイクル1.19 S2: approve-target の投げ先差し替え（newProjectId） ──────────

test('150. approveTarget: newProjectId 未指定なら patch に projectId を含めない（現行維持）', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async listProjects() { return [{ id: 'proj_x' }]; } });
  const result = await approveTarget(
    { client, core, settings: settings() },
    { id: 'd1', projectId: 'proj_x', instruction: 'x' }
  );
  assert.equal(result.ok, true);
  assert.equal('projectId' in calls.updateMany[0].data, false);
});

test('151. approveTarget: newProjectId 指定で patch に差し替え後 projectId が入り、freshCheck は差し替え先で行われる', async () => {
  const { client, calls } = createStubClient();
  const listProjectsCalls: unknown[] = [];
  const core = stubCore({
    async listProjects() {
      listProjectsCalls.push(true);
      return [{ id: 'proj_new' }]; // 元の proj_x は存在しない一覧（差し替え先でのみ freshCheck が通る）
    },
  });
  const result = await approveTarget(
    { client, core, settings: settings() },
    { id: 'd1', projectId: 'proj_x', instruction: 'x', newProjectId: 'proj_new' }
  );
  assert.equal(result.ok, true);
  assert.equal(calls.updateMany[0].data.projectId, 'proj_new');
  assert.equal(listProjectsCalls.length, 1);
});

test('152. approveTarget: 不正な newProjectId は fresh_check で無遷移（approveTargetHttpStatus は409）', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async listProjects() { return [{ id: 'proj_x' }]; } }); // proj_bogus は含まれない
  const result = await approveTarget(
    { client, core, settings: settings() },
    { id: 'd1', projectId: 'proj_x', instruction: 'x', newProjectId: 'proj_bogus' }
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'fresh_check');
    assert.match(result.reason, /proj_bogus/);
  }
  assert.equal(calls.updateMany.length, 0);
  assert.equal(approveTargetHttpStatus(result), 409);
});

// ── サイクル1.19 S3: approve-plan の任意追記テキスト（note） ────────────────

test('153. approvePlan: note 未指定なら patch に approveNote を含めない（現行維持）', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async getPlan() { return { status: 'ready', planMarkdown: '# plan' }; } });
  const result = await approvePlan({ client, core }, { id: 'd1', submissionId: 's1' });
  assert.equal(result.outcome, 'approved');
  assert.equal('approveNote' in calls.updateMany[0].data, false);
});

test('154. approvePlan: note 指定で patch に approveNote が入る', async () => {
  const { client, calls } = createStubClient();
  const core = stubCore({ async getPlan() { return { status: 'ready', planMarkdown: '# plan' }; } });
  const result = await approvePlan(
    { client, core },
    { id: 'd1', submissionId: 's1', note: '案Bで進めてください' }
  );
  assert.equal(result.outcome, 'approved');
  assert.equal(calls.updateMany[0].data.approveNote, '案Bで進めてください');
});
