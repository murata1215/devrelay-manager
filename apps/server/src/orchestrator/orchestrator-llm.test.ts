import { test } from 'node:test';
import assert from 'node:assert/strict';
import { orchestrate } from './orchestrator-llm.js';
import type { LlmPort, OrchestrateDeps } from './orchestrator-llm.js';
import type { DraftSink, DraftCreateInput, CreatedDraft } from './draft-sink.js';
import { loadManagerSettings } from './manager-settings.js';
import type { ProjectCandidate } from './project-proposal.js';

function settings() {
  return loadManagerSettings({
    version: 1,
    defaultTier: 'standard',
    tierModels: {
      heavy: { model: 'claude-opus-5', label: 'Heavy' },
      standard: { model: 'claude-sonnet-5', label: 'Standard' },
      light: { model: 'claude-haiku-4-5-20251001', label: 'Light' },
    },
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

function llmReturning(raw: string): LlmPort {
  return { complete: async () => raw };
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
