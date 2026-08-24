/**
 * Dispatch 状態機械（サイクル1.7 ③-1）。
 *
 * このファイルが唯一の権威。「どの状態からどの状態へ遷移可能か」をデータ
 * （DISPATCH_STATES）として持ち、遷移関数（canTransition / assertTransition）は
 * この表しか参照しない。状態は10値（doc/orchestrator-layer3-design.md §2 の
 * 権威ある列挙。'pending' は含まない。理由は devlog を参照）。
 *
 * 純粋モジュール：import ゼロ。DB にも @prisma/client にも触れない。
 * DB とのやり取り（永続化・楽観ロック）は dispatch-store.ts が担う。
 */

/** Dispatch.status が取りうる値（10状態）。 */
export const DISPATCH_STATUSES = [
  'draft',
  'submitting',
  'planning',
  'awaiting_approval',
  'stale',
  'approving',
  'building',
  'done',
  'failed',
  'stopped',
] as const;

export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** worker が次アクションを実行する際の再試行安全性。 */
export type RetrySafety = 'idempotent' | 'at-most-once';

export interface NextAction {
  readonly op: 'submitInstruction' | 'pollPlan' | 'approveImplementation' | 'pollBuildStatus';
  readonly retry: RetrySafety;
}

/** Dispatch のこの状態にいる間、非 null であることが要求されるカラム。 */
export type RequiredField = 'instruction' | 'submissionId';

interface DispatchStateDef {
  /** この状態から遷移可能な状態一覧。空配列＝終端。 */
  readonly to: readonly DispatchStatus[];
  /** true なら人間の操作待ち（無期限保留・タイムアウトで stopped にしない。spec §8）。 */
  readonly awaitsHuman: boolean;
  /** worker が拾うべき次アクション。null なら worker の出番なし。 */
  readonly nextAction: NextAction | null;
  /** この状態のレコードが満たすべき非 null 制約。 */
  readonly requiredFields: readonly RequiredField[];
}

/**
 * 状態遷移表（唯一の定義）。
 *
 * 設計判断（devlog 参照）:
 * - draft -> failed は無い: draft の異常（freshCheck 失敗）は「勝手に諦めない」
 *   （spec §8）ため draft に留まり理由を提示する＝遷移しない。
 * - submitting -> failed / approving -> failed は無い: RPC 失敗は spec §10 の
 *   STOP 条件そのもの → stopped。failed は「core が実行し否定的結果を報告した」
 *   場合のみ（planning / building から）。
 * - submitting -> draft は無い: submit_instruction は冪等キーが無く、core 側に
 *   submission 一覧取得 API も無いため、クラッシュ後に受理有無を照合できない。
 *   孤児 submitting 行は必ず stopped（自動再試行は重複ビルドを招く）。
 * - stale -> draft がある: staleCheck が submission 死亡を検知した場合、
 *   stale -> planning は core が知らない ID への無限の袋小路になる。draft に
 *   戻すことでゲート①（宛先・内容の再承認）も再実行される（spec §3）。
 * - planning / building から stopped への遷移はポーリングバジェット（30分）
 *   枯渇・STOP・キャンセルを含む。spec §8 の「タイムアウトで stopped にしない」
 *   は人間ゲート（awaitsHuman な状態）限定であり、機械ポーリングには適用されない。
 */
const DISPATCH_STATES: Readonly<Record<DispatchStatus, DispatchStateDef>> = {
  draft: {
    to: ['submitting', 'stopped'],
    awaitsHuman: true,
    nextAction: null,
    requiredFields: [],
  },
  submitting: {
    to: ['planning', 'stopped'],
    awaitsHuman: false,
    nextAction: { op: 'submitInstruction', retry: 'at-most-once' },
    requiredFields: ['instruction'],
  },
  planning: {
    to: ['awaiting_approval', 'failed', 'stopped'],
    awaitsHuman: false,
    nextAction: { op: 'pollPlan', retry: 'idempotent' },
    requiredFields: ['submissionId'],
  },
  awaiting_approval: {
    to: ['approving', 'stale', 'stopped'],
    awaitsHuman: true,
    nextAction: null,
    requiredFields: ['submissionId'],
  },
  stale: {
    to: ['planning', 'draft', 'stopped'],
    awaitsHuman: true,
    nextAction: null,
    requiredFields: ['submissionId'],
  },
  approving: {
    to: ['building', 'stopped'],
    awaitsHuman: false,
    // approve_implementation は {phase} のみを返す（buildId は get_build_status で
    // 初めて分かる）。submitting と異なり get_build_status(submissionId) で
    // 「承認は通ったか」を照合できるため at-most-once だが復旧可能。
    nextAction: { op: 'approveImplementation', retry: 'at-most-once' },
    requiredFields: ['submissionId'],
  },
  building: {
    to: ['done', 'failed', 'stopped'],
    awaitsHuman: false,
    nextAction: { op: 'pollBuildStatus', retry: 'idempotent' },
    // buildId は必須にしない: approving -> building の時点では buildId は未知
    // （get_build_status の応答で初めて分かる、表示・監査用の値）。
    requiredFields: ['submissionId'],
  },
  done: { to: [], awaitsHuman: false, nextAction: null, requiredFields: [] },
  failed: { to: [], awaitsHuman: false, nextAction: null, requiredFields: [] },
  stopped: { to: [], awaitsHuman: false, nextAction: null, requiredFields: [] },
};

export { DISPATCH_STATES };

function isDispatchStatus(value: string): value is DispatchStatus {
  return (DISPATCH_STATUSES as readonly string[]).includes(value);
}

/** DB から読んだ生の文字列を DispatchStatus として検証する。未知の値はサイレントに扱わず throw する。 */
export function parseDispatchStatus(value: string): DispatchStatus {
  if (!isDispatchStatus(value)) {
    throw new Error(
      `不明な Dispatch.status です: "${value}"。有効な値は ${DISPATCH_STATUSES.join(', ')} のいずれかです（'pending' はサイクル1.7 ③-1 で状態機械から除外されました）。`
    );
  }
  return value;
}

/** from から to への遷移一覧に to が含まれるか。 */
export function canTransition(from: DispatchStatus, to: DispatchStatus): boolean {
  return DISPATCH_STATES[from].to.includes(to);
}

/**
 * from -> to が許可されているか検証する。不正なら例外を投げる（サイレント失敗禁止）。
 * エラーメッセージには現在状態・要求状態・許可される遷移先を含める。
 */
export function assertTransition(from: DispatchStatus, to: DispatchStatus): void {
  if (!canTransition(from, to)) {
    const allowed = allowedTransitionsFrom(from);
    const allowedText = allowed.length > 0 ? allowed.join(', ') : '(終端状態のため遷移不可)';
    throw new Error(
      `不正な Dispatch 状態遷移です: "${from}" -> "${to}" は許可されていません。` +
        ` 現在状態=${from} / 要求状態=${to} / 許可される遷移先=[${allowedText}]`
    );
  }
}

/** from から許可されている遷移先一覧。 */
export function allowedTransitionsFrom(status: DispatchStatus): readonly DispatchStatus[] {
  return DISPATCH_STATES[status].to;
}

/** 終端状態か（遷移先が存在しない）。 */
export function isTerminal(status: DispatchStatus): boolean {
  return DISPATCH_STATES[status].to.length === 0;
}

/** 人間の操作待ちか（無期限保留・spec §8 によりタイムアウトで stopped にしない）。 */
export function awaitsHuman(status: DispatchStatus): boolean {
  return DISPATCH_STATES[status].awaitsHuman;
}

/** worker が実行すべき次アクション。null なら worker の出番なし（人間待ち or 終端）。 */
export function nextActionFor(status: DispatchStatus): NextAction | null {
  return DISPATCH_STATES[status].nextAction;
}

/** この状態のレコードが満たすべき非 null 制約フィールド一覧。 */
export function requiredFieldsFor(status: DispatchStatus): readonly RequiredField[] {
  return DISPATCH_STATES[status].requiredFields;
}
