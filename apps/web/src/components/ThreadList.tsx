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
    <aside className="thread-list">
      <div className="thread-list__new">
        <input
          type="text"
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
        <button type="button" onClick={() => void handleCreate()} disabled={creating || title.trim().length === 0}>
          新規スレッド
        </button>
      </div>
      <ul className="thread-list__items">
        {threads.length === 0 && <li className="thread-list__empty">スレッドはまだありません</li>}
        {threads.map((thread) => (
          <li key={thread.id}>
            <button
              type="button"
              className={thread.id === selectedThreadId ? 'thread-list__item thread-list__item--active' : 'thread-list__item'}
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
