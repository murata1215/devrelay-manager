/**
 * Dispatch の読み取り専用ビュー（サイクル1.16 ④-1）。
 *
 * 「スレッドに紐づく Dispatch 一覧」と「単体取得（GET /dispatch/:id）」の両方が使う
 * 共有シリアライザ、およびスレッド別一覧の組み立てロジックを持つ。dispatch-store.ts
 * （状態遷移の書き手）とは責務が異なるため型を再利用/流用しない：
 *
 * - DispatchListRow（dispatch-store.ts）は worker 用の8列であり、API が返す20列に足りない。
 * - DispatchQueryClient.findMany（同）は take 必須・orderBy 配列という worker 専用の
 *   シグネチャ。ここで緩めると ③-1/③-2 の既存契約を弱めてしまうため触らない。
 *
 * dispatch-store.ts と同じ流儀（narrow な構造的インターフェースを呼び出し側が注入する）
 * を踏襲し、DB にもサーバ起動にも依存せずユニットテストできる形にする（import ゼロ）。
 */

/**
 * Prisma `Dispatch` のスカラー列（API が外に出す唯一の形）。
 * schema.prisma の model Dispatch と1:1（リレーション thread/message・@@index は含まない）。
 * この集合が GET /dispatch/:id の現行レスポンス形式そのものであり、変えてはならない
 * （#135 でスキーマとの一致を機械的に検査する）。
 */
export interface DispatchDetail {
  id: string;
  threadId: string;
  messageId: string | null;
  projectId: string;
  instruction: string | null;
  submissionId: string | null;
  buildId: string | null;
  status: string;
  statusChangedAt: Date;
  statusReason: string | null;
  lastPolledAt: Date | null;
  devlogPath: string | null;
  cost: number | null;
  tier: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  responseModel: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * ホワイトリスト方式の整形（GET /dispatch/:id と一覧の共通経路）。
 * 入力にホワイトリスト外のプロパティ（例: 将来 select 漏れで紛れ込んだ列）が
 * 混ざっていても、出力には DispatchDetail の20列しか現れない。
 *
 * status は parseDispatchStatus で検証しない（現行 GET /dispatch/:id と同じ透過）。
 * 読み取り専用の一覧・単体取得が、未知の status 値で 500 を返す方が実害が大きい
 * （表示側で「不明な状態」として出せば足りる）ためこの判断はここに残す。
 */
export function serializeDispatch(row: DispatchDetail): DispatchDetail {
  return {
    id: row.id,
    threadId: row.threadId,
    messageId: row.messageId,
    projectId: row.projectId,
    instruction: row.instruction,
    submissionId: row.submissionId,
    buildId: row.buildId,
    status: row.status,
    statusChangedAt: row.statusChangedAt,
    statusReason: row.statusReason,
    lastPolledAt: row.lastPolledAt,
    devlogPath: row.devlogPath,
    cost: row.cost,
    tier: row.tier,
    model: row.model,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    responseModel: row.responseModel,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** listThreadDispatches が要求する最小の Thread 読み取りインターフェース。 */
export interface ThreadReadClient {
  findUnique(args: { where: { id: string } }): Promise<{ id: string; deletedAt: Date | null } | null>;
}

/** listThreadDispatches が要求する最小の Dispatch 一覧取得インターフェース。 */
export interface ThreadDispatchListClient {
  findMany(args: {
    where: { threadId: string };
    orderBy: { createdAt: 'asc' };
  }): Promise<DispatchDetail[]>;
}

export type ListThreadDispatchesResult =
  | { ok: true; dispatches: DispatchDetail[] }
  | { ok: false; code: 'thread_not_found'; reason: string };

/**
 * スレッドに紐づく Dispatch 一覧を取得する。
 *
 * - スレッドを先に引く。存在しない、または論理削除済み（deletedAt != null）なら
 *   thread_not_found を返し、findMany は一切呼ばない（無駄な問い合わせをしない、かつ
 *   「削除済みスレッドの行が漏れる」余地を構造的に無くす）。
 * - Dispatch 自体には論理削除の概念が現時点のスキーマに存在しない（deletedAt 列が無い）。
 *   そのため「生きているスレッドの Dispatch は全件返す」が正しい動作になる。
 * - 並び順は createdAt 昇順固定（タイムライン表示の要求どおり）。
 */
export async function listThreadDispatches(
  deps: { threads: ThreadReadClient; dispatches: ThreadDispatchListClient },
  threadId: string
): Promise<ListThreadDispatchesResult> {
  const thread = await deps.threads.findUnique({ where: { id: threadId } });
  if (!thread || thread.deletedAt) {
    return { ok: false, code: 'thread_not_found', reason: 'thread not found' };
  }
  const rows = await deps.dispatches.findMany({
    where: { threadId },
    orderBy: { createdAt: 'asc' },
  });
  return { ok: true, dispatches: rows.map(serializeDispatch) };
}

/** 1.15 の approveTargetHttpStatus と同じ流儀の写像（ルート起動なしで検証できる）。 */
export function listThreadDispatchesHttpStatus(result: ListThreadDispatchesResult): 200 | 404 {
  return result.ok ? 200 : 404;
}

/**
 * サイクル1.17 ④-1b: Dispatch プラン取り寄せ（GET /dispatch/:id/plan）。
 *
 * manager DB はプラン本文を持たない（権威は core、manager は submissionId 参照のみ。
 * 構想 §8.3）。フロントのゲート②承認カード表示のため、core から都度取り寄せる。
 */

/** core が返すプランのうち API が外に出す唯一の形（ホワイトリスト）。 */
export interface DispatchPlanPayload {
  status: string;
  planMarkdown?: string;
  summary?: string;
  executable?: boolean;
}

/** fetchDispatchPlan が要求する最小の Dispatch 読み取りインターフェース（更新系は持たせない）。 */
export interface DispatchPlanReadClient {
  findUnique(args: { where: { id: string } }): Promise<
    { id: string; threadId: string; submissionId: string | null; status: string } | null
  >;
}

/** get_plan だけを要求する最小の core インターフェース（coreClient.getPlan がそのまま入る）。 */
export interface PlanCoreClient {
  getPlan(submissionId: string): Promise<unknown>;
}

export type DispatchPlanResult =
  | { ok: true; plan: DispatchPlanPayload }
  | { ok: false; code: 'dispatch_not_found'; reason: string }
  | { ok: false; code: 'plan_not_ready'; reason: string; status: string }
  | { ok: false; code: 'core_unavailable'; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * core が返すプランの生応答をホワイトリスト整形する。
 * classifyPlanResult（core-result.ts）はここでは使わない — kind（ready/pending/...）へ
 * 潰すと「core の結果をそのまま整形して返す」「planning 中は status: 'planning' で
 * 素通し」という本 API の要求に反するため。判断はここに残す。
 */
function toPlanPayload(raw: unknown): DispatchPlanPayload | null {
  if (!isRecord(raw) || typeof raw.status !== 'string') {
    // status 自体が欠落・型不正 = 応答が想定形をしていない。判定不能（no-silent-failure）。
    return null;
  }
  const payload: DispatchPlanPayload = { status: raw.status };
  if (typeof raw.planMarkdown === 'string') payload.planMarkdown = raw.planMarkdown;
  if (typeof raw.summary === 'string') payload.summary = raw.summary;
  if (typeof raw.executable === 'boolean') payload.executable = raw.executable;
  return payload;
}

/**
 * Dispatch に紐づくプランを core から取り寄せる（読み取り専用・副作用ゼロ）。
 *
 * 手順（必要になるまで次の問い合わせをしない）:
 * ① Dispatch を引く（無ければ dispatch_not_found、Thread も core も呼ばない）
 * ② 所属 Thread の soft-delete を確認（削除済みなら dispatch_not_found、core は呼ばない。
 *    理由文言は存在を漏らさないよう ① と同じ 'dispatch not found' に統一する）
 * ③ submissionId が無ければ plan_not_ready（draft/submitting 等、core は呼ばない）
 * ④ core.getPlan を呼ぶ。失敗（接続不可・タイムアウト等）は core_unavailable。
 *    manager 側の Dispatch 状態は一切変更しない（更新系メソッドをそもそも deps に
 *    持たせていないため構造的に不可能）。
 */
export async function fetchDispatchPlan(
  deps: { dispatches: DispatchPlanReadClient; threads: ThreadReadClient; core: PlanCoreClient },
  dispatchId: string
): Promise<DispatchPlanResult> {
  const dispatch = await deps.dispatches.findUnique({ where: { id: dispatchId } });
  if (!dispatch) {
    return { ok: false, code: 'dispatch_not_found', reason: 'dispatch not found' };
  }

  const thread = await deps.threads.findUnique({ where: { id: dispatch.threadId } });
  if (!thread || thread.deletedAt) {
    return { ok: false, code: 'dispatch_not_found', reason: 'dispatch not found' };
  }

  if (!dispatch.submissionId) {
    return {
      ok: false,
      code: 'plan_not_ready',
      reason: 'この Dispatch には submissionId がありません。',
      status: dispatch.status,
    };
  }

  let raw: unknown;
  try {
    raw = await deps.core.getPlan(dispatch.submissionId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, code: 'core_unavailable', reason: message };
  }

  const plan = toPlanPayload(raw);
  if (!plan) {
    return {
      ok: false,
      code: 'core_unavailable',
      reason: 'core の plan 応答が想定形をしていません。',
    };
  }

  return { ok: true, plan };
}

/** 1.15/1.16 と同じ流儀の写像（ルート起動なしで検証できる）。 */
export function fetchDispatchPlanHttpStatus(result: DispatchPlanResult): 200 | 404 | 409 | 502 {
  if (result.ok) return 200;
  if (result.code === 'dispatch_not_found') return 404;
  if (result.code === 'plan_not_ready') return 409;
  return 502;
}
