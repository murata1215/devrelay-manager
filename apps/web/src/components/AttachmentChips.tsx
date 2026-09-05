/**
 * サイクル1.28: チャット入力の添付チップ（テキストのみ、フェーズ1）。
 *
 * ProjectPicker.tsx のチップ／ポップオーバー流儀をそのまま踏襲する
 * （チップ: rounded-full border-accent bg-accent/10、ポップオーバー: fixed backdrop +
 * absolute bottom-full ...）。プレビューは読み取り専用（編集はフェーズ2以降）。
 * 画面を埋めないよう max-h-60 でスクロールし、表示のみ先頭20,000文字に留める
 * （送信内容・LLM入力・core への content は常に全文。表示上の制限のみ）。
 */
import { useState } from 'react';
import type { Attachment } from '../lib/attachment.js';
import { formatBytes } from '../lib/attachment.js';

const PREVIEW_DISPLAY_LIMIT = 20_000;

interface AttachmentChipsProps {
  attachments: Attachment[];
  onRemove: (id: string) => void;
  disabled: boolean;
}

export function AttachmentChips({ attachments, onRemove, disabled }: AttachmentChipsProps) {
  const [previewId, setPreviewId] = useState<string | null>(null);

  if (attachments.length === 0) {
    return null;
  }

  const previewing = attachments.find((a) => a.id === previewId) ?? null;

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {attachments.map((attachment) => (
        <span
          key={attachment.id}
          className="relative inline-flex items-center gap-1 rounded-full border border-accent bg-accent/10 px-2 py-0.5 text-xs text-text"
        >
          <button
            type="button"
            className="max-w-48 truncate hover:underline"
            onClick={() => setPreviewId(attachment.id)}
            title="クリックして内容をプレビュー"
          >
            {attachment.filename} · {formatBytes(attachment.byteSize)}
          </button>
          <button
            type="button"
            className="text-muted hover:text-danger"
            aria-label={`${attachment.filename} を削除`}
            onClick={() => onRemove(attachment.id)}
            disabled={disabled}
          >
            ×
          </button>

          {previewId === attachment.id && previewing && (
            <>
              {/* ポップオーバー外クリックで閉じるための透明バックドロップ（ProjectPicker と同流儀）。 */}
              <div className="fixed inset-0 z-10" onClick={() => setPreviewId(null)} />
              <div className="absolute bottom-full left-0 z-20 mb-1 max-h-60 w-[40rem] max-w-[90vw] overflow-y-auto rounded-sm border border-border bg-surface p-2 text-left normal-case">
                <div className="mb-1 flex items-center justify-between text-xs text-muted">
                  <span>
                    {previewing.filename}（{formatBytes(previewing.byteSize)}）
                  </span>
                  <button type="button" className="hover:text-text" onClick={() => setPreviewId(null)}>
                    閉じる
                  </button>
                </div>
                <pre className="whitespace-pre-wrap break-words text-xs font-mono text-text">
                  {previewing.text.slice(0, PREVIEW_DISPLAY_LIMIT)}
                </pre>
                {previewing.text.length > PREVIEW_DISPLAY_LIMIT && (
                  <p className="mt-1 text-xs text-muted">
                    （全{previewing.text.length}文字中、先頭{PREVIEW_DISPLAY_LIMIT}文字を表示）
                  </p>
                )}
              </div>
            </>
          )}
        </span>
      ))}
    </div>
  );
}
