/**
 * 左サイドバー: スレッド一覧 + 新規スレッド作成フォーム。
 */
import { useState } from 'react';
import type { ThreadDto } from '../types.js';

interface ThreadListProps {
  threads: ThreadDto[];
  selectedThreadId: string | null;
  onSelect: (threadId: string) => void;
  onCreate: (title: string) => Promise<void>;
}

export function ThreadList({ threads, selectedThreadId, onSelect, onCreate }: ThreadListProps) {
  const [title, setTitle] = useState('');
  const [creating, setCreating] = useState(false);

  async function handleCreate() {
    const trimmed = title.trim();
    if (trimmed.length === 0 || creating) {
      return;
    }
    setCreating(true);
    try {
      await onCreate(trimmed);
      setTitle('');
    } finally {
      setCreating(false);
    }
  }

  return (
    <aside className="h-full flex flex-col p-2 overflow-y-auto">
      <div className="flex flex-col gap-1 mb-3 shrink-0">
        <input
          type="text"
          className="w-full rounded-sm border border-border bg-bg px-2 py-1.5 text-sm text-text placeholder:text-muted focus:outline-none focus:border-accent"
          value={title}
          placeholder="新規スレッドのタイトル"
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              void handleCreate();
            }
          }}
          disabled={creating}
        />
        <button
          type="button"
          className="rounded-sm bg-accent text-white text-sm font-medium py-1.5 disabled:opacity-50"
          onClick={() => void handleCreate()}
          disabled={creating || title.trim().length === 0}
        >
          新規スレッド
        </button>
      </div>
      <ul className="list-none m-0 p-0 flex flex-col gap-0.5">
        {threads.length === 0 && (
          <li className="text-muted text-sm px-2 py-1.5">スレッドはまだありません</li>
        )}
        {threads.map((thread) => (
          <li key={thread.id}>
            <button
              type="button"
              className={
                'block w-full text-left truncate px-2 py-1.5 rounded-sm text-sm ' +
                (thread.id === selectedThreadId
                  ? 'bg-accent/10 text-text font-medium'
                  : 'text-muted hover:bg-bg hover:text-text')
              }
              onClick={() => onSelect(thread.id)}
            >
              {thread.title}
            </button>
          </li>
        ))}
      </ul>
    </aside>
  );
}
