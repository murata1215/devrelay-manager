/**
 * Dispatch の状態表示ロジック（サイクル1.18 ④-2）。
 *
 * apps/server/src/orchestrator/dispatch-state.ts の10状態をフロント側で
 * 独立に定義する（ワークスペース間 import はしない方針のため）。
 * 未知の status（サーバー側の将来変更等）は 'unknown' に落とし、
 * 画面が壊れないようにする（GET /dispatch/:id が status を検証せず透過する
 * 設計と方向性を合わせている）。
 */

/** 10状態の日本語ラベル。 */
export const DISPATCH_STATUS_LABELS: Record<string, string> = {
  draft: '下書き',
  submitting: '送信中',
  planning: 'プラン作成中',
  awaiting_approval: 'プラン承認待ち',
  stale: '取りこぼし',
  approving: '承認処理中',
  building: 'ビルド中',
  done: '完了',
  failed: '失敗',
  stopped: '中止済み',
};

/** 終端状態（これ以上遷移しない）の集合。 */
const TERMINAL_STATUSES = new Set(['done', 'failed', 'stopped']);

/** 状態が終端かどうか。未知状態は終端扱いしない（ポーリングを止めない側に倒す）。 */
export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** バッジの色トーン。 */
export type StatusTone = 'wait' | 'run' | 'ok' | 'ng' | 'unknown';

/** 状態 → バッジ色トーンの写像。 */
export function statusToneOf(status: string): StatusTone {
  switch (status) {
    case 'draft':
    case 'awaiting_approval':
    case 'stale':
      return 'wait';
    case 'submitting':
    case 'planning':
    case 'approving':
    case 'building':
      return 'run';
    case 'done':
      return 'ok';
    case 'failed':
    case 'stopped':
      return 'ng';
    default:
      return 'unknown';
  }
}

/** カードの表示種別。DispatchCard の分岐に使う。 */
export type CardKind = 'draft' | 'plan' | 'stale' | 'done' | 'progress' | 'unknown';

/** 状態 → カード種別の写像。 */
export function cardKindFor(status: string): CardKind {
  switch (status) {
    case 'draft':
      return 'draft';
    case 'awaiting_approval':
      return 'plan';
    case 'stale':
      return 'stale';
    case 'done':
      return 'done';
    case 'submitting':
    case 'planning':
    case 'approving':
    case 'building':
    case 'failed':
    case 'stopped':
      return 'progress';
    default:
      return 'unknown';
  }
}

/** 中止ボタンを出してよいか（非終端状態のみ true）。 */
export function canCancel(status: string): boolean {
  return !isTerminalStatus(status);
}

/**
 * ポーリングを続けるべきか。
 * 選択中スレの dispatches に非終端状態が1件でも含まれていれば true。
 * 空配列（Dispatch がまだ無い）なら false。
 */
export function shouldPoll(dispatches: { status: string }[]): boolean {
  return dispatches.some((d) => !isTerminalStatus(d.status));
}

/** done カードの1行分（ラベルと表示値）。 */
export interface DoneRow {
  label: string;
  value: string;
}

/** done カードに表示しうる項目の定義（ラベルと値の取り出し方）。 */
const DONE_ROW_DEFS: { label: string; pick: (d: DoneDispatchLike) => string | number | null | undefined }[] = [
  { label: 'submissionId', pick: (d) => d.submissionId },
  { label: 'buildId', pick: (d) => d.buildId },
  { label: 'devlogPath', pick: (d) => d.devlogPath },
  { label: 'inputTokens', pick: (d) => d.inputTokens },
  { label: 'outputTokens', pick: (d) => d.outputTokens },
  { label: 'responseModel', pick: (d) => d.responseModel },
];

/** doneRowsOf が受け取る Dispatch の最小形（DispatchDto の部分集合）。 */
export interface DoneDispatchLike {
  submissionId: string | null;
  buildId: string | null;
  devlogPath: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  responseModel: string | null;
}

/**
 * done カードに表示する行を組み立てる（サイクル1.19 W4）。
 * null / undefined / 空文字の項目は行ごと除外し、`?? '-'` の表示ノイズを無くす。
 */
export function doneRowsOf(dispatch: DoneDispatchLike): DoneRow[] {
  const rows: DoneRow[] = [];
  for (const def of DONE_ROW_DEFS) {
    const value = def.pick(dispatch);
    if (value === null || value === undefined || value === '') {
      continue;
    }
    rows.push({ label: def.label, value: String(value) });
  }
  return rows;
}

/**
 * 承認メモ（approveNote）の表示要否と表示値を1つにまとめる（サイクル1.20 W2）。
 * doneRowsOf と同じ「値が無ければ出さない」思想を承認メモ単体に適用したもの。
 * null / 空文字 / 空白のみは null を返し、呼び出し側は真偽値として使える。
 */
export function approveNoteOf(dispatch: { approveNote: string | null }): string | null {
  const trimmed = dispatch.approveNote?.trim() ?? '';
  return trimmed === '' ? null : trimmed;
}

/**
 * council バッジの表示要否と表示ラベルを1つにまとめる（サイクル1.21 W3）。
 * approveNoteOf と同じ「値が無ければ出さない」思想。true のときだけ 'council' を返し、
 * false / null / undefined はすべて null（バッジ非表示）にする。
 */
export function councilBadgeOf(dispatch: { council?: boolean | null }): string | null {
  return dispatch.council === true ? 'council' : null;
}
