/**
 * manager API のレスポンス／リクエスト型。
 *
 * apps/server のスキーマ（routes/*.ts, orchestrator/dispatch-view.ts）を読んで
 * 手で書き写したもの。apps/server 側の型を import はしない
 * （ワークスペース間依存を作らない・apps/server には一切触らない方針のため）。
 * サーバー側の形が変わってもここは追随して手動更新する。
 */

/** スレッド（横断会話の入れ物）。 */
export interface ThreadDto {
  id: string;
  title: string;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
}

/** メッセージ。role は 'user'（人間発言）と 'manager'（orchestrator LLM 発言）の2値。 */
export interface MessageDto {
  id: string;
  threadId: string;
  role: 'user' | 'manager';
  content: string;
  createdAt: string;
  tier: string | null;
  model: string | null;
}

/**
 * Dispatch（per-repo の1サイクル）。20列すべて。
 * apps/server/src/orchestrator/dispatch-view.ts の DispatchDetail と1:1。
 */
export interface DispatchDto {
  id: string;
  threadId: string;
  messageId: string | null;
  projectId: string;
  instruction: string | null;
  submissionId: string | null;
  buildId: string | null;
  status: string;
  statusChangedAt: string;
  statusReason: string | null;
  lastPolledAt: string | null;
  devlogPath: string | null;
  cost: number | null;
  tier: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  responseModel: string | null;
  createdAt: string;
  updatedAt: string;
}

/** core が持つプロジェクト（1プロジェクト=1リポジトリ）。 */
export interface CoreProjectDto {
  id: string;
  name: string;
  path: string;
  machine: string;
  machineId: string;
  online: boolean;
  aiTool: string;
}

/** GET /dispatch/:id/plan のレスポンス（core からの取り寄せをホワイトリスト整形したもの）。 */
export interface DispatchPlanDto {
  status: string;
  planMarkdown?: string;
  summary?: string;
  executable?: boolean;
}

/** POST /threads/:id/orchestrate の成功レスポンス。 */
export interface OrchestrateResultDto {
  messageId: string;
  result: unknown;
}

/** approve-plan / retry-stale の戻り値（outcome ベースの判別共用体）。 */
export interface GateOutcomeDto {
  outcome: string;
  detail?: string;
}
