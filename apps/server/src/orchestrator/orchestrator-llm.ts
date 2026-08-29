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

/** LLM 呼び出しの usage（トークン数）。記録のみ・集計は非スコープ（サイクル1.13）。 */
export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

/**
 * LLM 呼び出し結果。text は今までどおり zod で厳格検証する対象、model は API が
 * 実際に使用したと申告したモデルID（要求値 = resolveModel の結果との突き合わせ用）。
 */
export interface LlmCompletion {
  text: string;
  model: string;
  usage: LlmUsage;
}

/**
 * LLM 呼び出しの注入ポート。実クライアントは apps/server/src/llm/anthropic-llm.ts
 * （サイクル1.13 実LLM結線）。この層は SDK を import せず、この interface だけを知る。
 */
export interface LlmPort {
  complete(request: { model: string; system: string; user: string }): Promise<LlmCompletion>;
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
  /**
   * サイクル1.19 S1: ルート（web）が渡すプロジェクト候補ヒント。あくまでヒントであり、
   * 候補一覧（candidates）に存在しない id は無視する（エラーにしない）。
   */
  preferredProjectIds?: readonly string[];
  /**
   * サイクル1.21: claude↔codex の協議（council）を有効化するオプトイン。
   * true のときだけ draft.createDraft へ渡す（未指定/false は draft 側の
   * @default(false) に委ねる。1.20 の approveNote と同じ「明示時だけ含める」流儀）。
   */
  council?: boolean;
}

export type OrchestrateResult =
  | { kind: 'conversation'; reply: string; usage: LlmUsage; responseModel: string }
  | {
      kind: 'proposal';
      draftId: string;
      projectId: string;
      candidates: AnnotatedCandidate[];
      tier: Tier;
      model: string;
      instruction: string;
      usage: LlmUsage;
      responseModel: string;
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

/**
 * サイクル1.19 S1: preferred が空/未指定なら拡張前と1バイトも変わらない文字列を返す
 * （後方互換をテストで固定する）。候補に存在しない id は無視する（ヒントに過ぎないため）。
 */
function buildSystemPrompt(
  candidates: readonly ProjectCandidate[],
  preferred?: readonly string[]
): string {
  const candidateList = candidates
    .map((c) => `- id=${c.projectId} name=${c.name} path=${c.path} online=${c.online}`)
    .join('\n');
  const base =
    '以下は候補プロジェクトの一覧です。ユーザー発話が特定リポジトリへの作業依頼なら ' +
    '{"kind":"dispatch","projectId":"...","intent":"plan"|"exec"|"background"|null,"body":"..."} を、' +
    '純粋な会話・質問なら {"kind":"conversation","reply":"..."} を厳密な JSON のみで返してください。\n' +
    candidateList;

  const validPreferred = (preferred ?? []).filter((id) => candidates.some((c) => c.projectId === id));
  if (validPreferred.length === 0) {
    return base;
  }
  return (
    base +
    '\nユーザーは次を候補として選択しています: ' +
    validPreferred.join(', ')
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

  const completion = await deps.llm.complete({
    model: resolveModel(resolveTier(input.intent ?? null, input.tierOverride ?? null), deps.settings),
    system: buildSystemPrompt(input.candidates, input.preferredProjectIds),
    user: input.content,
  });

  const parsed = parseLlmOutput(completion.text);
  if (!parsed.ok) {
    return { kind: 'invalid', issues: parsed.issues };
  }

  if (parsed.value.kind === 'conversation') {
    // spec §9 の安全網: 純粋な会話は draft を一切作らない。
    return {
      kind: 'conversation',
      reply: parsed.value.reply,
      usage: completion.usage,
      responseModel: completion.model,
    };
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
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    responseModel: completion.model,
    // サイクル1.21: true のときだけ含める。未指定/false は既存と同形の呼び出しを保つ。
    ...(input.council === true ? { council: true } : {}),
  });

  return {
    kind: 'proposal',
    draftId: created.id,
    projectId: chosen.projectId,
    candidates: annotated,
    tier,
    model,
    instruction,
    usage: completion.usage,
    responseModel: completion.model,
  };
}
