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
    return <div className="timeline timeline--empty">まだメッセージがありません。下の入力欄から指示を送ってください。</div>;
  }

  return (
    <div className="timeline">
      {items.map((item) => {
        if (item.kind === 'message') {
          const role = item.message.role;
          return (
            <div key={item.id} className={`bubble bubble--${role}`}>
              <div className="bubble__role">{role === 'user' ? 'あなた' : 'manager'}</div>
              <div className="bubble__content">{item.message.content}</div>
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
