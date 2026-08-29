/**
 * Dispatch 状態遷移の永続化層（サイクル1.7 ③-1）。
 *
 * dispatch-state.ts（純粋・遷移表）を DB に結びつける薄い層。
 * PrismaClient を直接 import しない — 最小の DispatchClient インターフェースを
 * 呼び出し側から注入する（prisma.dispatch は構造的にこれを満たすのでそのまま渡せる）。
 * これによりテストは DB にもスキーマ生成にも依存せず、スタブだけで完結する。
 *
 * 「状態遷移は必ず DB を更新してから確定する」＝プロセス内メモリに状態を持たない、
 * という要求はこのモジュールが唯一の書き手であることで担保する。
 */
import { assertTransition, requiredFieldsFor } from './dispatch-state.js';
import type { DispatchStatus } from './dispatch-state.js';
import { POLL_INTERVALS_MINUTES } from './poll-schedule.js';

/** transitionDispatch が書き込める副次データ。渡されたキーのみが同一 UPDATE に含まれる。 */
export interface DispatchPatch {
  submissionId?: string | null;
  buildId?: string | null;
  instruction?: string | null;
  devlogPath?: string | null;
  /** サイクル1.19 S2: approve-target で投げ先を差し替える場合のみ含める。 */
  projectId?: string;
  /** サイクル1.19 S3: ゲート②承認時の自由記述。core への approve_implementation note に伝播する。 */
  approveNote?: string | null;
}

interface DispatchUpdateManyArgs {
  where: { id: string; status: DispatchStatus };
  data: Record<string, unknown>;
}

interface DispatchFindUniqueArgs {
  where: { id: string };
}

interface DispatchRow {
  status: string;
}

/**
 * dispatch-store が要求する最小の永続化インターフェース。
 * `prisma.dispatch` はこれを構造的に満たすため、そのまま渡せる。
 */
export interface DispatchClient {
  updateMany(args: DispatchUpdateManyArgs): Promise<{ count: number }>;
  findUnique(args: DispatchFindUniqueArgs): Promise<DispatchRow | null>;
}

export interface TransitionDispatchInput {
  id: string;
  from: DispatchStatus;
  to: DispatchStatus;
  /** stopped / failed 等で人間に提示する理由（spec §10 no-silent-failure）。省略時は statusReason を明示的に null にする。 */
  reason?: string;
  /**
   * to と同一 UPDATE に書き込む副次データ。
   * to が要求するフィールド（requiredFieldsFor(to)）は、変更の有無にかかわらず
   * 呼び出し側が既知の値をここで渡さなければならない（store は DB を読み返して
   * 補完しない＝ store 自体が DB 読み取りに依存しない設計にするため）。
   */
  patch?: DispatchPatch;
  /**
   * statusChangedAt に書き込む時刻（省略時は new Date()）。
   * サイクル1.8 ③-2 のテストでクロックを注入できるようにするための追加（呼び出し側の
   * 契約は変更しない＝既存呼び出しは省略可）。
   */
  at?: Date;
}

function buildTransitionData(
  to: DispatchStatus,
  reason: string | undefined,
  patch: DispatchPatch,
  at: Date | undefined
): Record<string, unknown> {
  return {
    status: to,
    statusChangedAt: at ?? new Date(),
    statusReason: reason ?? null,
    lastPolledAt: null,
    ...patch,
  };
}

function missingRequiredFields(to: DispatchStatus, patch: DispatchPatch): string[] {
  return requiredFieldsFor(to).filter((field) => {
    const value = patch[field];
    return value === null || value === undefined;
  });
}

/**
 * Dispatch の状態を遷移し、DB を更新する。
 *
 * - DB に触る前に (1) 遷移そのものの妥当性 (2) 遷移後の不変条件、を検証する。
 *   不正なら DB へは一切書き込まずに throw する（サイレント失敗禁止）。
 * - 楽観ロック: updateMany の where に現在状態 (from) を含めることで、
 *   競合する並行遷移のどちらか一方が必ず count=0 になる。
 * - 副次データ (patch) は status と同一の UPDATE で書く。これを分けると
 *   「status は進んだが submissionId が無い」ような、クラッシュのタイミング次第で
 *   永久に復帰不能な行が生まれる（③-1 が防ぐべき失敗そのもの）。
 * - statusReason は理由が渡されない限り必ず null に上書きする（前状態の理由が
 *   後続状態に残ると誤情報になる＝ no-silent-failure の反転）。
 * - lastPolledAt は状態が変わるたび null にリセットする（ポーリング間隔の起点は
 *   常に「この状態に入ってから」であるべきため。間隔ロジック自体は ③-2 スコープ）。
 */
export async function transitionDispatch(
  client: DispatchClient,
  input: TransitionDispatchInput
): Promise<void> {
  const { id, from, to, reason, patch = {}, at } = input;

  // (1) 遷移そのものの妥当性。DB には触らない。
  assertTransition(from, to);

  // (2) 遷移後の不変条件。DB には触らない。
  const missing = missingRequiredFields(to, patch);
  if (missing.length > 0) {
    throw new Error(
      `Dispatch 状態遷移の不変条件違反です: "${from}" -> "${to}" は [${missing.join(', ')}] を要求しますが、` +
        `patch に非 null な値がありません（patch=${JSON.stringify(patch)}）。`
    );
  }

  const data = buildTransitionData(to, reason, patch, at);

  const result = await client.updateMany({ where: { id, status: from }, data });

  if (result.count === 0) {
    const row = await client.findUnique({ where: { id } });
    if (!row) {
      throw new Error(
        `Dispatch 状態遷移に失敗しました: id=${id} が見つかりません（遷移 "${from}" -> "${to}" を試みました）。`
      );
    }
    throw new Error(
      `Dispatch 状態遷移に失敗しました: id=${id} を "${from}" -> "${to}" へ遷移しようとしましたが、` +
        `実際の現在状態は "${row.status}" でした（別の遷移が先に成功したか、想定と異なる状態です）。`
    );
  }
}

/**
 * assertTransition / 不変条件チェックは transitionDispatch と同じだが、count===0 を
 * 例外にせず false を返す。多重起動下では他インスタンスに先を越されて count===0 に
 * なることが正常系として起こりうる（サイクル1.8 ③-2: worker の tick から呼ぶ）。
 */
export async function tryTransitionDispatch(
  client: DispatchClient,
  input: TransitionDispatchInput
): Promise<boolean> {
  const { id, from, to, reason, patch = {}, at } = input;

  assertTransition(from, to);

  const missing = missingRequiredFields(to, patch);
  if (missing.length > 0) {
    throw new Error(
      `Dispatch 状態遷移の不変条件違反です: "${from}" -> "${to}" は [${missing.join(', ')}] を要求しますが、` +
        `patch に非 null な値がありません（patch=${JSON.stringify(patch)}）。`
    );
  }

  const data = buildTransitionData(to, reason, patch, at);
  const result = await client.updateMany({ where: { id, status: from }, data });
  return result.count === 1;
}

/**
 * claimDispatch / notePollResult / findActionableDispatches が要求する読み取り用インターフェース。
 * DispatchClient を拡張するだけなので、transitionDispatch / tryTransitionDispatch の
 * 契約（DispatchClient）自体は変更しない（③-1 の既存テスト・型を壊さない）。
 */
export interface DispatchListRow {
  id: string;
  status: string;
  statusChangedAt: Date;
  lastPolledAt: Date | null;
  submissionId: string | null;
  buildId: string | null;
  projectId: string;
  instruction: string | null;
  /** サイクル1.19 S3: worker が approveImplementation の第3引数へ渡す。 */
  approveNote: string | null;
  /** サイクル1.21: worker が submitInstruction の第3引数へ渡す。 */
  council: boolean;
}

interface DispatchFindManyArgs {
  where: Record<string, unknown>;
  orderBy: Array<Record<string, unknown>>;
  take: number;
}

export interface DispatchQueryClient extends DispatchClient {
  findMany(args: DispatchFindManyArgs): Promise<DispatchListRow[]>;
}

export interface ClaimDispatchInput {
  id: string;
  status: DispatchStatus;
  now: Date;
}

/**
 * 「この行を今 tick で処理する権利」を CAS で獲得する。status は変更しない
 * （遷移表を迂回した status UPDATE の禁止に抵触しない）— 書き込むのは lastPolledAt のみ。
 * count===1 を取れたインスタンスだけが後続の RPC を打ってよい。負けたインスタンスは
 * 静かにスキップする（多重起動時の二重処理防止の中核）。
 */
export async function claimDispatch(client: DispatchClient, input: ClaimDispatchInput): Promise<boolean> {
  const { id, status, now } = input;
  const result = await client.updateMany({
    where: { id, status },
    data: { lastPolledAt: now },
  });
  return result.count === 1;
}

export interface NotePollResultInput {
  id: string;
  status: DispatchStatus;
  /** ポーリング結果が非決定的（pending/running/unknown）だった際に記録する副次データ。status は変えない。 */
  patch?: DispatchPatch;
}

/**
 * 状態遷移を伴わないポーリング結果の記録（例: 判定不能な応答を得た、途中経過の
 * buildId が分かった等）。where に現在 status を含めて CAS するが、渡された patch
 * フィールドが空なら DB には触れない（無駄な書き込みをしない）。
 */
export async function notePollResult(client: DispatchClient, input: NotePollResultInput): Promise<void> {
  const { id, status, patch = {} } = input;
  const keys = Object.keys(patch) as Array<keyof DispatchPatch>;
  if (keys.length === 0) {
    return;
  }
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    data[key] = patch[key];
  }
  await client.updateMany({ where: { id, status }, data });
}

export interface FindActionableDispatchesInput {
  now: Date;
  statuses: readonly DispatchStatus[];
  limit: number;
}

/**
 * worker の tick 候補行を取得する。
 *
 * - status は呼び出し側（dispatch-worker.ts）が dispatch-state.ts の表から導出した
 *   一覧をそのまま渡す（このモジュールでは status をハードコードしない）。
 * - SQL 事前フィルタ「lastPolledAt が null、または最小間隔(2分)以上前」は健全な
 *   過剰取得（false positive はあっても false negative は無い）。厳密な due 判定
 *   （poll-schedule.ts の isPollDue）は worker 側で行単位に再確認する。
 * - 並び順は lastPolledAt 昇順(null優先)→statusChangedAt 昇順。statusChangedAt だけで
 *   並べるとポーリング中は値が動かないため古い行が take 枠を独占し、新しい行が
 *   飢餓する（サイクル1.8 ③-2 で発見）。
 */
export async function findActionableDispatches(
  client: DispatchQueryClient,
  input: FindActionableDispatchesInput
): Promise<DispatchListRow[]> {
  const { now, statuses, limit } = input;
  const minIntervalMs = POLL_INTERVALS_MINUTES[0] * 60_000;
  const cutoff = new Date(now.getTime() - minIntervalMs);

  return client.findMany({
    where: {
      status: { in: [...statuses] },
      OR: [{ lastPolledAt: null }, { lastPolledAt: { lte: cutoff } }],
    },
    orderBy: [{ lastPolledAt: { sort: 'asc', nulls: 'first' } }, { statusChangedAt: 'asc' }],
    take: limit,
  });
}
