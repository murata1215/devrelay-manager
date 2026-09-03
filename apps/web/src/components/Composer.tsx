/**
 * 右下: 入力欄（textarea + 送信ボタン + council トグル）。
 *
 * サイクル1.21: council トグルを実結線した（従来は disabled 固定で値を持たない
 * ダミーだった）。ON にすると orchestrate へ council: true が乗る。
 * ただし core の submit_instruction は council を受け取らない（未知引数を静かに
 * 捨てる）ため、現時点では web→server→DB までが結線され、core の実挙動は
 * まだ変わらない（doc/devlog 参照）。
 */
import { useState } from 'react';

interface ComposerProps {
  disabled: boolean;
  onSend: (content: string, council: boolean) => Promise<void>;
}

export function Composer({ disabled, onSend }: ComposerProps) {
  const [content, setContent] = useState('');
  const [council, setCouncil] = useState(false);
  const [sending, setSending] = useState(false);

  async function handleSend() {
    const trimmed = content.trim();
    if (trimmed.length === 0 || sending || disabled) {
      return;
    }
    setSending(true);
    try {
      await onSend(trimmed, council);
      setContent('');
      // council のチェック状態は送信後も維持する（連続で協議付き投入したい場合の意図を保つ）。
    } finally {
      setSending(false);
    }
  }

  const isBusy = sending || disabled;

  return (
    <div className="rounded-lg border border-border bg-surface p-3 flex flex-col gap-2">
      <textarea
        className="w-full resize-y border-0 bg-transparent text-text placeholder:text-muted focus:outline-none"
        value={content}
        placeholder="指示を入力してください"
        onChange={(e) => setContent(e.target.value)}
        disabled={isBusy}
        rows={3}
      />
      <div className="flex items-center gap-3">
        {/* サイクル1.21で結線した council トグルは維持する。視覚的に控えめに配置するのみ（1.23）。 */}
        <label
          className="flex items-center gap-1 text-xs text-muted ml-auto"
          title="claude↔codex の協議を有効化（既定 OFF）"
        >
          <input
            type="checkbox"
            checked={council}
            onChange={(e) => setCouncil(e.target.checked)}
            disabled={isBusy}
          />
          council
        </label>
        <button
          type="button"
          className="rounded-sm bg-accent text-white text-sm font-medium px-4 py-1.5 disabled:opacity-50"
          onClick={() => void handleSend()}
          disabled={isBusy || content.trim().length === 0}
        >
          送信
        </button>
      </div>
    </div>
  );
}
