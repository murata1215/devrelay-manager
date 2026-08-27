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
