/**
 * 右上: タイムライン。messages と dispatches を createdAt 昇順で混ぜて表示する。
 * 結合ロジック本体は lib/timeline.ts の純粋関数（テスト対象）に切り出してある。
 */
import type { CoreProjectDto, DispatchDto, MessageDto } from '../types.js';
import { buildTimeline } from '../lib/timeline.js';
import { DispatchCard } from './DispatchCard.js';

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

  if (items.length === 0) {
    return <div className="text-muted text-center py-16">まだメッセージがありません。下の入力欄から指示を送ってください。</div>;
  }

  return (
    <div className="flex flex-col gap-4">
      {items.map((item) => {
        if (item.kind === 'message') {
          const role = item.message.role;
          if (role === 'user') {
            return (
              <div key={item.id} className="self-end max-w-[80%] rounded-lg bg-accent/10 px-3 py-2">
                <div className="text-xs text-muted mb-1">あなた</div>
                <div className="whitespace-pre-wrap break-words">{item.message.content}</div>
              </div>
            );
          }
          return (
            <div key={item.id} className="self-start max-w-[80%]">
              <div className="text-xs text-muted mb-1">manager</div>
              <div className="whitespace-pre-wrap break-words">{item.message.content}</div>
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
    </div>
  );
}
