/**
 * タイムライン結合ロジック（サイクル1.18 ④-2）。
 *
 * 選択中スレの messages と dispatches を createdAt 昇順で1本に混ぜる純粋関数。
 * DOM も fetch も触らないため node --test で単体検証できる。
 */
import type { MessageDto, DispatchDto } from '../types.js';

/** タイムラインの1要素。message か dispatch のどちらかを保持する判別共用体。 */
export type TimelineItem =
  | { kind: 'message'; at: string; id: string; message: MessageDto }
  | { kind: 'dispatch'; at: string; id: string; dispatch: DispatchDto };

/**
 * messages と dispatches を createdAt 昇順で1本のタイムラインに混ぜる。
 *
 * - 同一 createdAt（文字列比較で等しい）の場合は message を先に置く
 *   （メッセージが Dispatch を生む契機であることが多く、読み順として自然なため）。
 * - 上記でも決着しない場合は id の文字列比較で安定化させる（結果の再現性を保証する）。
 */
export function buildTimeline(messages: MessageDto[], dispatches: DispatchDto[]): TimelineItem[] {
  const items: TimelineItem[] = [
    ...messages.map((message): TimelineItem => ({ kind: 'message', at: message.createdAt, id: message.id, message })),
    ...dispatches.map((dispatch): TimelineItem => ({ kind: 'dispatch', at: dispatch.createdAt, id: dispatch.id, dispatch })),
  ];

  items.sort((a, b) => {
    if (a.at !== b.at) {
      return a.at < b.at ? -1 : 1;
    }
    if (a.kind !== b.kind) {
      // 同時刻なら message を先に表示する。
      return a.kind === 'message' ? -1 : 1;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  return items;
}
