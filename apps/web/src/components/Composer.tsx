/**
 * 右下: 入力欄（textarea + 送信ボタン + council トグル）。
 */
import { useState } from 'react';

interface ComposerProps {
  disabled: boolean;
  onSend: (content: string) => Promise<void>;
}

export function Composer({ disabled, onSend }: ComposerProps) {
  const [content, setContent] = useState('');
  const [sending, setSending] = useState(false);

  async function handleSend() {
    const trimmed = content.trim();
    if (trimmed.length === 0 || sending || disabled) {
      return;
    }
    setSending(true);
    try {
      await onSend(trimmed);
      setContent('');
    } finally {
      setSending(false);
    }
  }

  const isBusy = sending || disabled;

  return (
    <div className="composer">
      <textarea
        value={content}
        placeholder="指示を入力してください"
        onChange={(e) => setContent(e.target.value)}
        disabled={isBusy}
        rows={3}
      />
      <div className="composer__actions">
        <label className="composer__council" title="⑤ council 結線後に有効化">
          <input type="checkbox" disabled />
          council
        </label>
        <button type="button" onClick={() => void handleSend()} disabled={isBusy || content.trim().length === 0}>
          送信
        </button>
      </div>
    </div>
  );
}
