/**
 * LLM 層が唯一持つ DB 書き込み口（サイクル1.11 ③-3）。
 *
 * 【境界の要】DraftSink には createDraft しか生えていない。DraftCreateInput には
 * status フィールドが存在しない（Dispatch.status は Prisma スキーマ側で
 * `@default("draft")` のため、create 時に status を渡さなければ必ず draft になる。
 * apps/server/prisma/schema.prisma 参照）。
 *
 * updateMany / findUnique（dispatch-store.ts の DispatchClient が持つ遷移用メソッド）は
 * この interface に一切含まれない。orchestrator-llm.ts はこのファイルの型しか import
 * しないため、transitionDispatch 等の遷移関数へ到達する手段を型として持たない
 * （import 禁止リストの検証は orchestrator-llm-structure.test.ts の構造テスト（AST・
 * 推移閉包）で機械確認する）。
 *
 * dispatch-store.ts / dispatch-state.ts / dispatch-gates.ts は無変更（③-1/③-2 非改変）。
 */
import type { Tier } from './tier.js';

export interface DraftCreateInput {
  threadId: string;
  messageId?: string | null;
  projectId: string;
  /** governance 適用済みの全文（composeInstruction の戻り値をそのまま渡す想定）。 */
  instruction: string;
  tier: Tier;
  model: string;
  /**
   * サイクル1.13 実LLM結線: orchestrator LLM 呼び出しの usage（記録のみ・集計は非スコープ）。
   * 未結線時（テスト等）は省略可能。省略時は Prisma の nullable 列に null が入る。
   */
  inputTokens?: number | null;
  outputTokens?: number | null;
  /** API が実際に使用したと申告したモデルID（要求値 model との突き合わせ用）。 */
  responseModel?: string | null;
  /**
   * サイクル1.21: claude↔codex の協議（council）を有効化するオプトイン。
   * 未指定時は Prisma の `@default(false)` に委ねる（省略可能）。
   */
  council?: boolean;
}

export interface CreatedDraft {
  id: string;
}

/** LLM 層に渡す唯一の DB 書き込み口。 */
export interface DraftSink {
  createDraft(input: DraftCreateInput): Promise<CreatedDraft>;
}

interface DispatchCreateArgs {
  data: {
    threadId: string;
    messageId?: string | null;
    projectId: string;
    instruction: string;
    tier: string;
    model: string;
    inputTokens?: number | null;
    outputTokens?: number | null;
    responseModel?: string | null;
    council?: boolean;
  };
}

interface DispatchCreateResult {
  id: string;
}

/** prisma.dispatch が満たす最小のインターフェース（create のみ）。 */
export interface DraftCreateClient {
  create(args: DispatchCreateArgs): Promise<DispatchCreateResult>;
}

/**
 * DraftCreateClient（prisma.dispatch 等）を DraftSink へ橋渡しする。
 * data に status を含めないことが、この関数がこのファイルに存在する理由そのもの。
 */
export function prismaDraftSink(client: DraftCreateClient): DraftSink {
  return {
    async createDraft(input: DraftCreateInput): Promise<CreatedDraft> {
      const data: DispatchCreateArgs['data'] = {
        threadId: input.threadId,
        messageId: input.messageId ?? null,
        projectId: input.projectId,
        instruction: input.instruction,
        tier: input.tier,
        model: input.model,
        inputTokens: input.inputTokens ?? null,
        outputTokens: input.outputTokens ?? null,
        responseModel: input.responseModel ?? null,
      };
      // サイクル1.21: council が true のときだけキーを足す。未指定/false のときは
      // 従来と完全同形の data（キー集合）を保ち、Prisma の @default(false) に委ねる。
      if (input.council === true) {
        data.council = true;
      }
      const row = await client.create({ data });
      return { id: row.id };
    },
  };
}
