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

/** transitionDispatch が書き込める副次データ。渡されたキーのみが同一 UPDATE に含まれる。 */
export interface DispatchPatch {
  submissionId?: string | null;
  buildId?: string | null;
  instruction?: string | null;
  devlogPath?: string | null;
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
  const { id, from, to, reason, patch = {} } = input;

  // (1) 遷移そのものの妥当性。DB には触らない。
  assertTransition(from, to);

  // (2) 遷移後の不変条件。DB には触らない。
  const missing = requiredFieldsFor(to).filter((field) => {
    const value = patch[field];
    return value === null || value === undefined;
  });
  if (missing.length > 0) {
    throw new Error(
      `Dispatch 状態遷移の不変条件違反です: "${from}" -> "${to}" は [${missing.join(', ')}] を要求しますが、` +
        `patch に非 null な値がありません（patch=${JSON.stringify(patch)}）。`
    );
  }

  const data: Record<string, unknown> = {
    status: to,
    statusChangedAt: new Date(),
    statusReason: reason ?? null,
    lastPolledAt: null,
    ...patch,
  };

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
