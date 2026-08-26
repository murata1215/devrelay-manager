import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from './orchestrator-llm.js';
import type { LlmPort, LlmCompletion, OrchestrateDeps } from './orchestrator-llm.js';
import type { DraftSink, DraftCreateInput, CreatedDraft } from './draft-sink.js';
import { loadManagerSettings } from './manager-settings.js';
import type { ProjectCandidate } from './project-proposal.js';

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

function candidates(): ProjectCandidate[] {
  return [
    { projectId: 'proj-1', name: 'pixblog', path: '/srv/pixblog', machine: 'ubuntu-prod', online: true },
    { projectId: 'proj-2', name: 'pixdraft', path: '/srv/pixdraft', machine: 'ubuntu-prod', online: true },
  ];
}

/**
 * サイクル1.13: LlmPort.complete は LlmCompletion（text/model/usage）を返すよう拡張された。
 * 既存テストは raw JSON 文字列のみに関心があるため、usage/model は固定のダミー値を返す
 * ヘルパーとして維持する（既存アサーションは変更しない）。
 */
function llmReturning(raw: string, overrides: Partial<Omit<LlmCompletion, 'text'>> = {}): LlmPort {
  const completion: LlmCompletion = {
    text: raw,
    model: overrides.model ?? 'claude-sonnet-5',
    usage: overrides.usage ?? { inputTokens: 111, outputTokens: 222 },
  };
  return { complete: async () => completion };
}

function recordingSink(): { sink: DraftSink; calls: DraftCreateInput[] } {
  const calls: DraftCreateInput[] = [];
  const sink: DraftSink = {
    async createDraft(input: DraftCreateInput): Promise<CreatedDraft> {
      calls.push(input);
      return { id: 'dispatch-created-1' };
    },
  };
  return { sink, calls };
}

function baseInput(overrides: Partial<Parameters<typeof orchestrate>[1]> = {}) {
  return {
    threadId: 'thread-1',
    content: 'ユーザー発話',
    candidates: candidates(),
    managerRepoPath: '/home/keisuke/devrelay-manager',
    ...overrides,
  };
}

test('90. orchestrate: 会話判定は kind:conversation を返し draft を一切呼ばない', async () => {
  const { sink, calls } = recordingSink();
  const deps: OrchestrateDeps = {
    llm: llmReturning(JSON.stringify({ kind: 'conversation', reply: 'こんにちは' })),
    draft: sink,
    settings: settings(),
  };
  const result = await orchestrate(deps, baseInput());
  assert.equal(result.kind, 'conversation');
  assert.equal(calls.length, 0);
});

test('91. orchestrate: dispatch 判定は draft を1回だけ呼び、instruction が governance 適用済み・tier/model 解決済み', async () => {
  const { sink, calls } = recordingSink();
  const deps: OrchestrateDeps = {
    llm: llmReturning(
      JSON.stringify({ kind: 'dispatch', projectId: 'proj-1', intent: 'exec', body: 'READMEを更新して' })
    ),
    draft: sink,
    settings: settings(),
  };
  const result = await orchestrate(deps, baseInput());
  assert.equal(result.kind, 'proposal');
  assert.equal(calls.length, 1);
  if (result.kind === 'proposal') {
    assert.equal(result.tier, 'heavy'); // intent:'exec' -> heavy
    assert.equal(result.model, 'claude-opus-5');
    assert.ok(result.instruction.startsWith('===HEADER==='));
    assert.ok(result.instruction.includes('READMEを更新して'));
    assert.ok(result.instruction.endsWith('===FOOTER=== devlog STOP'));
  }
  assert.equal(calls[0].projectId, 'proj-1');
  assert.equal(calls[0].tier, 'heavy');
});

test('92. orchestrate: LLM 出力が JSON でなければ invalid を返し draft を呼ばない', async () => {
  const { sink, calls } = recordingSink();
  const deps: OrchestrateDeps = {
    llm: llmReturning('これはJSONではありません'),
    draft: sink,
    settings: settings(),
  };
  const result = await orchestrate(deps, baseInput());
  assert.equal(result.kind, 'invalid');
  assert.equal(calls.length, 0);
});

test('93. orchestrate: LLM 出力がスキーマ違反なら invalid を返し draft を呼ばない', async () => {
  const { sink, calls } = recordingSink();
  const deps: OrchestrateDeps = {
    llm: llmReturning(JSON.stringify({ kind: 'dispatch', projectId: 'proj-1' /* body 欠落 */ })),
    draft: sink,
    settings: settings(),
  };
  const result = await orchestrate(deps, baseInput());
  assert.equal(result.kind, 'invalid');
  assert.equal(calls.length, 0);
});

test('94. orchestrate: 候補外の projectId は invalid を返し draft を呼ばない', async () => {
  const { sink, calls } = recordingSink();
  const deps: OrchestrateDeps = {
    llm: llmReturning(
      JSON.stringify({ kind: 'dispatch', projectId: 'not-a-candidate', body: 'なにかやって' })
    ),
    draft: sink,
    settings: settings(),
  };
  const result = await orchestrate(deps, baseInput());
  assert.equal(result.kind, 'invalid');
  assert.equal(calls.length, 0);
});

test('95. orchestrate: 自己ループ候補が proposal の candidates に警告付きで含まれる', async () => {
  const { sink } = recordingSink();
  const selfLoopCandidates: ProjectCandidate[] = [
    {
      projectId: 'proj-self',
      name: 'devrelay-manager',
      path: '/home/keisuke/devrelay-manager',
      machine: 'ubuntu-prod/keisuke',
      online: true,
    },
  ];
  const deps: OrchestrateDeps = {
    llm: llmReturning(JSON.stringify({ kind: 'dispatch', projectId: 'proj-self', body: '何かやって' })),
    draft: sink,
    settings: settings(),
  };
  const result = await orchestrate(
    deps,
    baseInput({ candidates: selfLoopCandidates, managerRepoPath: '/home/keisuke/devrelay-manager' })
  );
  assert.equal(result.kind, 'proposal');
  if (result.kind === 'proposal') {
    assert.equal(result.candidates[0].selfLoopWarning, true);
    assert.ok(result.candidates[0].warningText && result.candidates[0].warningText.length > 0);
  }
});

test('117. orchestrate: proposal 時に inputTokens/outputTokens/responseModel が createDraft に渡り、結果にも usage/responseModel が含まれる（サイクル1.13 実LLM結線）', async () => {
  const { sink, calls } = recordingSink();
  const deps: OrchestrateDeps = {
    llm: llmReturning(
      JSON.stringify({ kind: 'dispatch', projectId: 'proj-1', body: 'READMEを更新して' }),
      { model: 'claude-opus-5', usage: { inputTokens: 321, outputTokens: 654 } }
    ),
    draft: sink,
    settings: settings(),
  };
  const result = await orchestrate(deps, baseInput());
  assert.equal(result.kind, 'proposal');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inputTokens, 321);
  assert.equal(calls[0].outputTokens, 654);
  assert.equal(calls[0].responseModel, 'claude-opus-5');
  if (result.kind === 'proposal') {
    assert.deepEqual(result.usage, { inputTokens: 321, outputTokens: 654 });
    assert.equal(result.responseModel, 'claude-opus-5');
  }
});

test('118. orchestrate: conversation 時も usage/responseModel を結果に含むが createDraft は0回のまま（spec §9 の安全網は不変・サイクル1.13）', async () => {
  const { sink, calls } = recordingSink();
  const deps: OrchestrateDeps = {
    llm: llmReturning(
      JSON.stringify({ kind: 'conversation', reply: 'こんにちは' }),
      { model: 'claude-haiku-4-5-20251001', usage: { inputTokens: 10, outputTokens: 20 } }
    ),
    draft: sink,
    settings: settings(),
  };
  const result = await orchestrate(deps, baseInput());
  assert.equal(result.kind, 'conversation');
  assert.equal(calls.length, 0);
  if (result.kind === 'conversation') {
    assert.deepEqual(result.usage, { inputTokens: 10, outputTokens: 20 });
    assert.equal(result.responseModel, 'claude-haiku-4-5-20251001');
  }
});
