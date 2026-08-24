/**
 * ポーリング間隔・バジェットの純粋ロジック（サイクル1.8 ③-2）。
 *
 * 純粋モジュール：import ゼロ。Date.now() を内部で呼ばない — 全関数が
 * `now: Date` を引数で受け取る（テスト容易性・再起動を跨いだ再現性のため）。
 * dispatch-state.ts と同じ「唯一の権威をこのファイルに集約する」方針を踏襲する。
 */
import type { DispatchStatus } from './dispatch-state.js';
import { nextActionFor } from './dispatch-state.js';

/** spec §4: 2→3→4→5分で頭打ちのバックオフ階段。 */
export const POLL_INTERVALS_MINUTES = [2, 3, 4, 5] as const;

/**
 * idempotent なポーリング状態（= nextActionFor(status)?.retry === 'idempotent'）に
 * のみ適用するポーリングバジェット（分）。
 *
 * - planning: spec §4 の想定どおり30分（plan 生成は短時間で終わるはず）。
 * - building: spec §4 の30分より長い120分にする。30分は plan 生成の想定値であって
 *   実ビルドの所要時間としては短すぎると判断した（実測不能なので暫定値）。この
 *   乖離は doc/orchestrator-layer3-design.md §12 に新規 open item として記録する。
 */
export const POLL_BUDGET_MINUTES: Readonly<Partial<Record<DispatchStatus, number>>> = {
  planning: 30,
  building: 120,
};

/** at-most-once 状態の孤児（RPC 送信後 lastPolledAt が更新されたまま応答不明）を stopped にするまでの猶予。 */
export const ORPHAN_GRACE_MINUTES = 10;

const MINUTE_MS = 60_000;

/**
 * ある状態に入ってからの経過時間（ms）から、次のポーリングまでの間隔（ms）を返す。
 * 2→3→4→5分の階段で、5分を超えたら5分に頭打ちする（spec §4）。
 */
export function pollIntervalMsFor(elapsedInStateMs: number): number {
  const elapsedMinutes = elapsedInStateMs / MINUTE_MS;
  for (const stepMinutes of POLL_INTERVALS_MINUTES) {
    if (elapsedMinutes < stepMinutes) {
      return stepMinutes * MINUTE_MS;
    }
  }
  return POLL_INTERVALS_MINUTES[POLL_INTERVALS_MINUTES.length - 1] * MINUTE_MS;
}

/**
 * 今ポーリングしてよいか。
 *
 * lastPolledAt が null（この状態に入ってから一度も叩いていない）なら常に true
 * （最初のポーリングは即座に行う。以降の間隔だけを 2→3→4→5分の階段にする）。
 *
 * 間隔は「直前のポーリングが状態に入ってから何分後だったか」(elapsedAtLastPoll、
 * 固定された過去の値) から決める。"now" の経過時間を直接ブラケット選択に使うと、
 * 要求間隔自体が時間経過とともに際限なく伸び続け、「時間が経つほど due になりにくい」
 * という不動点の欠陥に陥る（③-1 devlog で発見された "elapsed のみからの
 * shouldPoll" バグの再発）。lastPolledAt という固定点を使うことでこれを避ける。
 */
export function isPollDue(now: Date, statusChangedAt: Date, lastPolledAt: Date | null): boolean {
  if (lastPolledAt === null) {
    return true;
  }
  const elapsedAtLastPoll = lastPolledAt.getTime() - statusChangedAt.getTime();
  const interval = pollIntervalMsFor(elapsedAtLastPoll);
  const sinceLastPoll = now.getTime() - lastPolledAt.getTime();
  return sinceLastPoll >= interval;
}

/**
 * この状態にポーリングバジェットが存在するか。
 * idempotent な nextAction を持つ状態（= planning / building）にのみ存在する。
 * 人間ゲート（awaitsHuman）や at-most-once 状態、終端状態にはバジェットが無い。
 */
export function budgetMinutesFor(status: DispatchStatus): number | null {
  const action = nextActionFor(status);
  if (!action || action.retry !== 'idempotent') {
    return null;
  }
  return POLL_BUDGET_MINUTES[status] ?? null;
}

/**
 * ポーリングバジェットが尽きているか（経過時間のみによる判定）。
 *
 * この関数自体は lastPolledAt を見ない。「バジェットが尽きていても最低1回は
 * ポーリングしてから stopped にする」という規則は dispatch-worker.ts 側で
 * `isBudgetExhausted(...) && lastPolledAt !== null` として組み合わせて実現する
 * （lastPolledAt === null の行は isPollDue が常に true を返すため、そちらで
 * 先に1回ポーリングされる）。manager プロセスが長時間ダウンしていた場合、
 * 復帰直後に「30分超えているから stopped」と即断すると、実際には成功している
 * build を確認せずに捨てることになるため、この分離が必要になる。
 */
export function isBudgetExhausted(
  now: Date,
  statusChangedAt: Date,
  status: DispatchStatus
): boolean {
  const budget = budgetMinutesFor(status);
  if (budget === null) {
    return false;
  }
  const elapsedMinutes = (now.getTime() - statusChangedAt.getTime()) / MINUTE_MS;
  return elapsedMinutes >= budget;
}
