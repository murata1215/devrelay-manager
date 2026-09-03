/**
 * 右上: タイムライン。messages と dispatches を createdAt 昇順で混ぜて表示する。
 * 結合ロジック本体は lib/timeline.ts の純粋関数（テスト対象）に切り出してある。
 *
 * サイクル1.25 要求D: manager 発言は Markdown 描画し、ラベル（あなた/manager）は
 * 吹き出しの外に置く。新着があれば末尾のセンチネルへ自動スクロールする。
 * scrollIntoView は祖先のスクロール要素を動かすため、実際のスクロール領域が
 * App.tsx 側（flex-1 overflow-y-auto）にあっても機能し、App.tsx 自体には手を入れない。
 * 少件数時の下詰めは、親（App.tsx）側の `min-h-full flex flex-col justify-end` で行う
 * （本コンポーネントは className/wrapper のみで対応し、ロジックを持たない）。
 */
import { useEffect, useRef } from 'react';
import type { CoreProjectDto, DispatchDto, MessageDto } from '../types.js';
import { buildTimeline } from '../lib/timeline.js';
import { DispatchCard } from './DispatchCard.js';
import { Markdown } from './Markdown.js';

interface TimelineProps {
  messages: MessageDto[];
  dispatches: DispatchDto[];
  projects: CoreProjectDto[];
  busyDispatchId: string | null;
  onBusyChange: (dispatchId: string, busy: boolean) => void;
  onDispatchChanged: () => void;
  onError: (message: string) => void;
  onInfo: (message: string) => void;
}

export function Timeline({
  messages,
  dispatches,
  projects,
  busyDispatchId,
  onBusyChange,
  onDispatchChanged,
  onError,
  onInfo,
}: TimelineProps) {
  const items = buildTimeline(messages, dispatches);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [items.length]);

  if (items.length === 0) {
    return (
      <div className="m-auto py-16 text-center text-muted">
        まだメッセージがありません。下の入力欄から指示を送ってください。
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {items.map((item) => {
        if (item.kind === 'message') {
          const role = item.message.role;
          if (role === 'user') {
            return (
              <div key={item.id} className="self-end max-w-[80%]">
                <div className="mb-1 text-right text-xs text-muted">あなた</div>
                <div className="whitespace-pre-wrap break-words rounded-lg bg-accent/10 px-3 py-2">
                  {item.message.content}
                </div>
              </div>
            );
          }
          return (
            <div key={item.id} className="self-start max-w-[80%]">
              <div className="mb-1 text-xs text-muted">manager</div>
              <Markdown>{item.message.content}</Markdown>
            </div>
          );
        }
        return (
          <DispatchCard
            key={item.id}
            dispatch={item.dispatch}
            projects={projects}
            busy={busyDispatchId === item.id}
            onBusyChange={(busy) => onBusyChange(item.id, busy)}
            onChanged={onDispatchChanged}
            onError={onError}
            onInfo={onInfo}
          />
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}
