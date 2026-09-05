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
 *
 * サイクル1.29: 送信の成否判定とクリア/保持の遷移は `lib/composer-send.ts` の
 * `performSend` に切り出した（DOM 無しのテストランナーからこの判断ロジックだけを
 * テストするため）。ここでは戻り値をそのまま setState するだけにする。
 *
 * サイクル1.35: チャット入力への画像添付（フェーズ2）。
 * - クリップボード貼り付け（スクリーンショット等）・ドラッグ＆ドロップ・ファイル選択の
 *   いずれでも画像4形式（png/jpeg/gif/webp）を添付できる。
 * - 拡張子・宣言 MIME は信用せず、必ず detectImageMimeType で実バイトから判定する
 *   （addFiles はファイル内容を読んでから判定するため、拡張子偽装ファイルでも
 *   正しい形式で扱われる。テキストとしても画像としても認識できないファイルは拒否する）。
 * - 貼り付けられた画像は `pasted-image.png` のように、フェーズ1のテキスト貼り付け
 *   （`pasted-text.txt`）と同じ `uniqueFilename` 採番規則（-2, -3, …）を使う
 *   （拡張子は検出された実形式に従う）。
 * - 画像本体は orchestrator LLM には渡さない（server 側 `attachment.ts` の二重防壁を参照）。
 *   ここではその防壁の対象となる `Attachment.kind`/`base64` を正しく組み立てるだけで、
 *   本コンポーネントは画像内容を一切解釈・表示加工しない。
 */
import { useRef, useState } from 'react';
import type { DragEvent } from 'react';
import {
  MAX_ATTACHMENT_COUNT,
  shouldAttachPaste,
  uniqueFilename,
  mimeTypeForFilename,
  detectImageMimeType,
  imageExtensionForMimeType,
  bytesToBase64,
  validateAttachments,
  type Attachment,
  type AllowedImageMimeType,
  type WireAttachment,
} from '../lib/attachment.js';
import { performSend } from '../lib/composer-send.js';
import { AttachmentChips } from './AttachmentChips.js';

export type { WireAttachment };

interface ComposerProps {
  disabled: boolean;
  onSend: (content: string, council: boolean, attachments: WireAttachment[]) => Promise<void>;
}

/** サイクル1.35: tryAddAttachments へ渡す候補の判別ユニオン（text/image）。 */
type AttachmentCandidate =
  | { kind: 'text'; filename: string; mimeType: 'text/plain' | 'text/markdown'; text: string }
  | { kind: 'image'; filename: string; mimeType: AllowedImageMimeType; base64: string; byteSize: number };

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
  function tryAddAttachments(candidates: AttachmentCandidate[]) {
    const existingNames = attachments.map((a) => a.filename);
    const added: Attachment[] = [];
    for (const candidate of candidates) {
      const filename = uniqueFilename(candidate.filename, [...existingNames, ...added.map((a) => a.filename)]);
      if (candidate.kind === 'image') {
        // サイクル1.35: 画像は text を常に空文字にする（二重防壁の2枚目。attachment.ts 冒頭コメント参照）。
        added.push({
          id: nextId(),
          filename,
          mimeType: candidate.mimeType,
          kind: 'image',
          text: '',
          base64: candidate.base64,
          byteSize: candidate.byteSize,
        });
      } else {
        added.push({
          id: nextId(),
          filename,
          mimeType: candidate.mimeType,
          kind: 'text',
          text: candidate.text,
          base64: '',
          byteSize: new TextEncoder().encode(candidate.text).length,
        });
      }
    }
    const merged = [...attachments, ...added];
    // サイクル1.29: 追加した時点で本文込みの合計文字数上限も評価する（送信前に気づけるように）。
    const reason = validateAttachments(merged, content.trim());
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

  /**
   * サイクル1.35: ファイル選択・ドラッグ＆ドロップで渡されたファイルを添付候補へ変換する。
   * 拡張子は信用せず、まず実バイトを読んで画像かどうかを magic byte で判定する
   * （画像として認識できなければテキスト拡張子として扱う）。1件でも非対応形式があれば
   * 何も追加せずエラー表示する（1.28 以前と同じ all-or-nothing の挙動を維持）。
   */
  async function addFiles(files: FileList | File[]) {
    const list = Array.from(files);
    if (list.length === 0) {
      return;
    }
    const candidates: AttachmentCandidate[] = [];
    for (const file of list) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const detectedImageMime = detectImageMimeType(bytes);
      if (detectedImageMime) {
        candidates.push({
          kind: 'image',
          filename: file.name,
          mimeType: detectedImageMime,
          base64: bytesToBase64(bytes),
          byteSize: bytes.length,
        });
        continue;
      }
      const mimeType = mimeTypeForFilename(file.name);
      if (!mimeType) {
        setError(
          `"${file.name}" は対応していない形式です（.txt / .md / .log、または png/jpeg/gif/webp 画像のみ）。`
        );
        return;
      }
      // file.text() と同じ UTF-8 デコード（不正バイト列は \uFFFD に置換される）。
      // 既に読み込んだ bytes を使い回し、画像判定と二重にファイルを読まない。
      const text = new TextDecoder('utf-8').decode(bytes);
      candidates.push({ kind: 'text', filename: file.name, mimeType, text });
    }
    tryAddAttachments(candidates);
  }

  /**
   * サイクル1.35: クリップボードに画像（スクリーンショット等）が含まれる場合は
   * `pasted-image.png` として添付化する（フェーズ1のテキスト貼り付けと同じ
   * uniqueFilename 採番規則。拡張子は検出された実形式に従う）。
   * 画像として認識できないファイルが混ざっていた場合は無視する（テキスト貼り付けの妨げにしない）。
   */
  async function addPastedImages(files: File[]) {
    const candidates: AttachmentCandidate[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const detected = detectImageMimeType(bytes);
      if (!detected) {
        continue;
      }
      candidates.push({
        kind: 'image',
        filename: `pasted-image${imageExtensionForMimeType(detected)}`,
        mimeType: detected,
        base64: bytesToBase64(bytes),
        byteSize: bytes.length,
      });
    }
    if (candidates.length > 0) {
      tryAddAttachments(candidates);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLTextAreaElement>) {
    const imageFiles = Array.from(e.clipboardData.files).filter((f) => f.type.startsWith('image/'));
    if (imageFiles.length > 0) {
      e.preventDefault();
      void addPastedImages(imageFiles);
      return;
    }
    const text = e.clipboardData.getData('text/plain');
    if (!shouldAttachPaste(text)) {
      return;
    }
    e.preventDefault();
    tryAddAttachments([{ kind: 'text', filename: 'pasted-text.txt', mimeType: 'text/plain', text }]);
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
      const next = await performSend({ content, attachments, error: null }, (c, a) => onSend(c, council, a));
      setContent(next.content);
      setAttachments([...next.attachments]);
      setError(next.error);
      // council のチェック状態は送受信の成否に関わらず維持する（連続で協議付き投入したい場合の意図を保つ）。
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
        placeholder="指示を入力してください（2000文字を超える貼り付け・画像の貼り付けは自動で添付になります）"
        onChange={(e) => setContent(e.target.value)}
        onPaste={handlePaste}
        disabled={isBusy}
        rows={3}
      />
      <div className="flex items-center gap-3">
        <input
          ref={fileInputRef}
          type="file"
          accept=".txt,.md,.log,.png,.jpg,.jpeg,.gif,.webp"
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
          title="ファイルを添付（.txt / .md / .log、または png / jpeg / gif / webp 画像）"
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
