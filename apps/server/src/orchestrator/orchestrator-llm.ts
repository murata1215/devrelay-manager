/**
 * orchestrator LLM 層（サイクル1.11 ③-3）。
 *
 * 【絶対の境界】この層は Dispatch の `draft` 行を作るところまで。状態遷移には
 * 一切関与しない。担保は三重（devlog にも記す）:
 *
 * 1. 型: この層が触れる DB 口は draft-sink.ts の DraftSink（createDraft のみ）。
 *    DraftCreateInput に status フィールドは存在しない（Prisma スキーマの
 *    @default("draft") が唯一の決定要因になる）。transitionDispatch 等の
 *    遷移関数への参照をこのファイルは持たない。
 * 2. import: 以下を一切 import しない —
 *    dispatch-state.js / dispatch-store.js / dispatch-gates.js / dispatch-worker.js /
 *    core/coreClient.js / db/client.js。
 *    プロジェクト候補（ProjectCandidate[]）は呼び出し側（routes/orchestrator.ts）が
 *    core から取得してデータとして渡す。この層は core RPC を一切呼ばない。
 * 3. テスト: orchestrator-llm-structure.test.ts の構造テストが、この層から相対 import を
 *    辿った推移閉包の全ファイルに禁止 import が無いことを AST で機械検証する
 *    （サイクル1.12 で正規表現から TypeScript Compiler API による AST 解析へ強化。
 *    副作用 import・動的 import()・require() も検出する）。
 *
 * 加えて spec §9「発話は常に提案。純粋な会話は Dispatch を作らない」を安全網として
 * 実装する：kind:'conversation' の場合は draft.createDraft を一切呼ばない。
 * 不正な LLM 出力（JSON でない／スキーマ違反／候補外 projectId／本文空）も同様に
 * draft.createDraft を呼ばず kind:'invalid' を返す（半端な行を作らない）。
 */
import { z } from 'zod';
import type { ManagerSettings } from './manager-settings.js';
import { resolveModel } from './manager-settings.js';
import { composeInstruction, assertGovernanceApplied } from './governance.js';
import { resolveTier } from './tier.js';
import type { Tier, Intent } from './tier.js';
import { annotateCandidates } from './project-proposal.js';
import type { ProjectCandidate, AnnotatedCandidate } from './project-proposal.js';
import type { DraftSink } from './draft-sink.js';

/** LLM 呼び出しの注入ポート。実クライアントの結線は本サイクル非スコープ（devlog参照）。 */
export interface LlmPort {
  complete(request: { model: string; system: string; user: string }): Promise<string>;
}

export interface OrchestrateDeps {
  llm: LlmPort;
  draft: DraftSink;
  settings: ManagerSettings;
}

export interface OrchestrateInput {
  threadId: string;
  messageId?: string | null;
  content: string;
  /** ルートが core から取得して渡す候補一覧。この層は自分で list_projects を呼ばない。 */
  candidates: readonly ProjectCandidate[];
  managerRepoPath: string;
  intent?: Intent | null;
  tierOverride?: Tier | null;
}

export type OrchestrateResult =
  | { kind: 'conversation'; reply: string }
  | {
      kind: 'proposal';
      draftId: string;
      projectId: string;
      candidates: AnnotatedCandidate[];
      tier: Tier;
      model: string;
      instruction: string;
    }
  | { kind: 'invalid'; issues: string[] };

/**
 * LLM に期待する出力スキーマ。未知キーは拒否する（strict）。
 * kind:'dispatch' の projectId は呼び出し側で候補集合に含まれるかを追加検証する
 * （zod だけでは「渡した候補一覧のどれか」までは表現できないため）。
 */
const llmOutputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('conversation'), reply: z.string().min(1) }).strict(),
  z
    .object({
      kind: z.literal('dispatch'),
      projectId: z.string().min(1),
      intent: z.enum(['plan', 'exec', 'background']).nullable().optional(),
      body: z.string().min(1),
    })
    .strict(),
]);

type LlmOutput = z.infer<typeof llmOutputSchema>;

function parseLlmOutput(raw: string): { ok: true; value: LlmOutput } | { ok: false; issues: string[] } {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, issues: ['LLM 出力が JSON として解釈できません。'] };
  }
  const result = llmOutputSchema.safeParse(json);
  if (!result.success) {
    return { ok: false, issues: result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  return { ok: true, value: result.data };
}

function buildSystemPrompt(candidates: readonly ProjectCandidate[]): string {
  const candidateList = candidates
    .map((c) => `- id=${c.projectId} name=${c.name} path=${c.path} online=${c.online}`)
    .join('\n');
  return (
    '以下は候補プロジェクトの一覧です。ユーザー発話が特定リポジトリへの作業依頼なら ' +
    '{"kind":"dispatch","projectId":"...","intent":"plan"|"exec"|"background"|null,"body":"..."} を、' +
    '純粋な会話・質問なら {"kind":"conversation","reply":"..."} を厳密な JSON のみで返してください。\n' +
    candidateList
  );
}

/**
 * 曖昧な人間発話から Dispatch の draft 行を組み立てる（または会話として返す）。
 *
 * 手順: ①LLM 呼び出し → ②zod で厳格に検証 → ③conversation なら draft を呼ばずに返す →
 * ④dispatch なら projectId が候補集合内か検証 → tier/model 解決 → governance 適用 →
 * draft.createDraft。不正出力はどの段階でも draft を一切呼ばずに 'invalid' を返す。
 */
export async function orchestrate(deps: OrchestrateDeps, input: OrchestrateInput): Promise<OrchestrateResult> {
  const annotated = annotateCandidates(input.candidates, input.managerRepoPath);

  const raw = await deps.llm.complete({
    model: resolveModel(resolveTier(input.intent ?? null, input.tierOverride ?? null), deps.settings),
    system: buildSystemPrompt(input.candidates),
    user: input.content,
  });

  const parsed = parseLlmOutput(raw);
  if (!parsed.ok) {
    return { kind: 'invalid', issues: parsed.issues };
  }

  if (parsed.value.kind === 'conversation') {
    // spec §9 の安全網: 純粋な会話は draft を一切作らない。
    return { kind: 'conversation', reply: parsed.value.reply };
  }

  const { projectId, intent, body } = parsed.value;
  const chosen = input.candidates.find((c) => c.projectId === projectId);
  if (!chosen) {
    return {
      kind: 'invalid',
      issues: [`projectId="${projectId}" は提示した候補一覧に含まれていません。`],
    };
  }

  const tier = resolveTier(intent ?? input.intent ?? null, input.tierOverride ?? null);
  const model = resolveModel(tier, deps.settings);
  const instruction = composeInstruction(body, deps.settings);
  assertGovernanceApplied(instruction, deps.settings);

  const created = await deps.draft.createDraft({
    threadId: input.threadId,
    messageId: input.messageId ?? null,
    projectId: chosen.projectId,
    instruction,
    tier,
    model,
  });

  return {
    kind: 'proposal',
    draftId: created.id,
    projectId: chosen.projectId,
    candidates: annotated,
    tier,
    model,
    instruction,
  };
}
