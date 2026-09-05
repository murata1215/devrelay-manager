/**
 * 右下: 入力欄（textarea + 送信ボタン + council トグル + 添付）。
 *
 * サイクル1.21: council トグルを実結線した（従来は disabled 固定で値を持たない
 * ダミーだった）。ON にすると orchestrate へ council: true が乗る。
 * ただし core の submit_instruction は council を受け取らない（未知引数を静かに
 * 捨てる）ため、現時点では web→server→DB までが結線され、core の実挙動は
 * まだ変わらない（doc/devlog 参照）。
 *
 * サイクル1.28: チャット入力へのテキスト添付（フェーズ1）。
 * - 2000文字超の貼り付けは本文へ挿入せず `pasted-text.txt` として添付化する。
 * - .txt/.md/.log ファイルをファイル選択またはドラッグ＆ドロップで添付できる。
 * - 添付は core `submit_instruction` の attachments へそのまま載る（instruction 本文には
 *   一切展開しない＝仕様5）。onSend の第3引数（wire 形式: filename/mimeType/content(base64)）
 *   としてのみ親へ渡す。
 */
import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  MAX_ATTACHMENT_COUNT,
  shouldAttachPaste,
  uniqueFilename,
  mimeTypeForFilename,
  validateAttachments,
  toWireAttachments,
  type Attachment,
} from '../lib/attachment.js';
import { AttachmentChips } from './AttachmentChips.js';

export type WireAttachment = ReturnType<typeof toWireAttachments>[number];

interface ComposerProps {
  disabled: boolean;
  onSend: (content: string, council: boolean, attachments: WireAttachment[]) => Promise<void>;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `att-${Date.now()}-${idCounter}`;
}

export function Composer({ disabled, onSend }: ComposerProps) {
  const [content, setContent] = useState('');
  const [council, setCouncil] = useState(false);
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const isBusy = sending || disabled;

  /** 新規添付候補を既存一覧へ追加する。件数/サイズ/UTF-8 検証に失敗したら追加せずエラー表示する。 */
  function tryAddAttachments(candidates: Array<{ filename: string; mimeType: 'text/plain' | 'text/markdown'; text: string }>) {
    const existingNames = attachments.map((a) => a.filename);
    const added: Attachment[] = [];
    for (const candidate of candidates) {
      const filename = uniqueFilename(candidate.filename, [...existingNames, ...added.map((a) => a.filename)]);
      added.push({
        id: nextId(),
        filename,
        mimeType: candidate.mimeType,
        text: candidate.text,
        byteSize: new TextEncoder().encode(candidate.text).length,
      });
    }
    const merged = [...attachments, ...added];
    const reason = validateAttachments(merged);
    if (reason) {
      setError(reason);
      return;
    }
    setError(null);
    setAttachments(merged);
  }

  function removeAttachment(id: string) {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  }

  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) {
      return;
    }
    const candidates: Array<{ filename: string; mimeType: 'text/plain' | 'text/markdown'; text: string }> = [];
    for (const file of list) {
      const mimeType = mimeTypeForFilename(file.name);
      if (!mimeType) {
        setError(`"${file.name}" は対応していない拡張子です（.txt / .md / .log のみ）。`);
        return;
      }
      const text = await file.text();
      candidates.push({ filename: file.name, mimeType, text });
    }
    tryAddAttachments(candidates);
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const text = e.clipboardData.getData('text/plain');
    if (!shouldAttachPaste(text)) {
      return;
    }
    e.preventDefault();
    tryAddAttachments([{ filename: 'pasted-text.txt', mimeType: 'text/plain', text }]);
  }

  function handleDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragging(false);
    if (isBusy) {
      return;
    }
    void addFiles(e.dataTransfer.files);
  }

  function handleDragOver(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (!isBusy) {
      setDragging(true);
    }
  }

  function handleDragLeave() {
    setDragging(false);
  }

  function handleFileInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files) {
      void addFiles(e.target.files);
    }
    e.target.value = '';
  }

  async function handleSend() {
    const trimmed = content.trim();
    if ((trimmed.length === 0 && attachments.length === 0) || sending || disabled) {
      return;
    }
    setSending(true);
    try {
      await onSend(trimmed, council, toWireAttachments(attachments));
      setContent('');
      setAttachments([]);
      setError(null);
      // council のチェック状態は送信後も維持する（連続で協議付き投入したい場合の意図を保つ）。
    } finally {
      setSending(false);
    }
  }

  return (
    <div
      className={
        'rounded-lg border p-3 flex flex-col gap-2 ' +
        (dragging ? 'border-accent' : 'border-border') +
        ' bg-surface'
      }
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {error && <p className="text-sm text-danger">{error}</p>}
      {attachments.length > 0 && (
        <AttachmentChips attachments={attachments} onRemove={removeAttachment} disabled={isBusy} />
      )}
      <textarea
        className="w-full resize-y border-0 bg-transparent text-text placeholder:text-muted focus:outline-none"
        value={content}
        placeholder="指示を入力してください（2000文字を超える貼り付けは自動で添付になります）"
        onChange={(e) => setContent(e.target.value)}
        onPaste={handlePaste}
        disabled={isBusy}
        rows={3}
      />
      <div className="flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.log"
          multiple
          className="hidden"
          onChange={handleFileInputChange}
          disabled={isBusy || attachments.length >= MAX_ATTACHMENT_COUNT}
        />
        <button
          type="button"
          className="rounded-sm border border-border px-2 py-1 text-xs text-muted hover:text-text disabled:opacity-50"
          onClick={() => fileInputRef.current?.click()}
          disabled={isBusy || attachments.length >= MAX_ATTACHMENT_COUNT}
          title="ファイルを添付（.txt / .md / .log）"
        >
          📎 添付
        </button>
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
          disabled={isBusy || (content.trim().length === 0 && attachments.length === 0)}
        >
          送信
        </button>
      </div>
    </div>
  );
}
