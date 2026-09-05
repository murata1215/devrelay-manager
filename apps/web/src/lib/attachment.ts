/**
 * サイクル1.28: チャット入力へのテキスト添付（フェーズ1）の純粋ロジック。
 *
 * ここに置くのは「DOM に触れない」判定・変換関数のみ（他の lib/*.ts と同じ方針）。
 * Composer.tsx 側は onPaste/onDrop/onChange からこれらの関数を呼ぶだけにする。
 *
 * 上限値は server 側 `apps/server/src/orchestrator/attachment.ts` と手動で同期する
 * （types.ts と同じ「import で結ばず手動同期」方針。web と server は別ワークスペースで
 * ビルド成果物を共有しないため）。特に MAX_TOTAL_TEXT_CHARS の導出根拠（140,000 文字）は
 * server 側ファイルの冒頭コメントに全文を書いてあるので、変更時はそちらを正として参照すること。
 */

/** 貼り付けを添付化する閾値。これを「超えた」場合のみ添付化する（2000 ちょうどは本文へ挿入）。 */
export const PASTE_ATTACH_THRESHOLD = 2000;

/** core MCP `submit_instruction` の tools/list を実機に問い合わせて確認した実測値。 */
export const MAX_ATTACHMENT_COUNT = 10;

/**
 * 1ファイルあたりの上限バイト数。core の description は「5MB」としか書かれておらず
 * 10進（5,000,000）か2進（5,242,880）か不明なため、厳しい側（10進）を採る。
 * こうすれば core が2進で実装していても境界で 413 になることはない。
 */
export const MAX_ATTACHMENT_BYTES = 5_000_000;

/** 添付合計の上限バイト数。単一ファイル上限と同じ理由で10進の厳しい側を採る。 */
export const MAX_TOTAL_ATTACHMENT_BYTES = 10_000_000;

/**
 * manager 独自の追加ガード（server 側 attachment.ts と同値）。
 * 導出根拠は server 側ファイルの冒頭コメントを参照（軽量tier Haiku 4.5 のコンテキスト
 * 窓 200,000 トークンから出力・システムプロンプト分を引いた予算に安全マージン20%を
 * 掛けて切り下げた値）。仕様4（verbatim）を守るため、超過時は切り詰めではなく拒否する。
 */
export const MAX_TOTAL_TEXT_CHARS = 140_000;

export type AllowedAttachmentMimeType = 'text/plain' | 'text/markdown';

export interface Attachment {
  id: string;
  filename: string;
  mimeType: AllowedAttachmentMimeType;
  /** デコード済みのテキスト本文（UI プレビュー・送信直前の base64 化の両方に使う）。 */
  text: string;
  /** UTF-8 エンコード後の生バイト数（上限判定・UI 表示に使う）。 */
  byteSize: number;
}

/** 貼り付けテキストを添付化すべきか（UTF-16 code unit 長で判定。2000 ちょうどは false）。 */
export function shouldAttachPaste(text: string): boolean {
  return text.length > PASTE_ATTACH_THRESHOLD;
}

/** ファイル名を拡張子とそれ以外（stem）に分割する。先頭ドットのみのファイルは拡張子無し扱い。 */
function splitExt(name: string): { stem: string; ext: string } {
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === name.length - 1) {
    return { stem: name, ext: '' };
  }
  return { stem: name.slice(0, dotIndex), ext: name.slice(dotIndex) };
}

/** 拡張子から許可 MIME タイプを決める（大文字小文字は無視）。該当なしは null（拒否）。 */
export function mimeTypeForFilename(name: string): AllowedAttachmentMimeType | null {
  const { ext } = splitExt(name);
  const lower = ext.toLowerCase();
  if (lower === '.md' || lower === '.markdown') {
    return 'text/markdown';
  }
  if (lower === '.txt' || lower === '.log') {
    return 'text/plain';
  }
  return null;
}

/** ファイル名の妥当性を検証する。問題があれば読める理由文字列、無ければ null。 */
export function validateFilename(name: string): string | null {
  if (name.trim().length === 0) {
    return 'ファイル名が空です。';
  }
  if (name === '.' || name === '..') {
    return `ファイル名に "${name}" は使用できません。`;
  }
  if (name.includes('/') || name.includes('\\')) {
    return 'ファイル名にパス区切り文字（/ または \\）は使用できません。';
  }
  if (new TextEncoder().encode(name).length > 255) {
    return 'ファイル名が長すぎます（255バイト以内にしてください）。';
  }
  return null;
}

/**
 * 既存ファイル名集合と衝突しないファイル名を返す。
 * `desired` が未使用ならそのまま返し、使用済みなら stem に `-2`, `-3`, … を付けて
 * 最小の未使用番号を返す（拡張子は保持）。隠しカウンタを持たないため、削除後に空いた
 * 番号は自然に再利用される。
 */
export function uniqueFilename(desired: string, existing: readonly string[]): string {
  const existingSet = new Set(existing);
  if (!existingSet.has(desired)) {
    return desired;
  }
  const { stem, ext } = splitExt(desired);
  let n = 2;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const candidate = `${stem}-${n}${ext}`;
    if (!existingSet.has(candidate)) {
      return candidate;
    }
    n += 1;
  }
}

/** バイト数を人間可読な文字列にする（B はそのまま、KB/MB は小数点1桁）。 */
export function formatBytes(n: number): string {
  if (n < 1000) {
    return `${n} B`;
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)} KB`;
  }
  return `${(n / 1_000_000).toFixed(1)} MB`;
}

/**
 * 添付一覧の妥当性を検証する。最初に見つかったエラーを読める理由文字列で返し、
 * すべて妥当なら null を返す。
 * - 件数は MAX_ATTACHMENT_COUNT 以下
 * - 各ファイル名は validateFilename を満たす
 * - UTF-8 として妥当（File.text() のデコード結果に \uFFFD が含まれていたら拒否。
 *   バイナリを .txt にリネームした場合を弾く）
 * - 各ファイルは MAX_ATTACHMENT_BYTES 以下
 * - 合計は MAX_TOTAL_ATTACHMENT_BYTES 以下
 */
export function validateAttachments(items: readonly Attachment[]): string | null {
  if (items.length > MAX_ATTACHMENT_COUNT) {
    return `添付ファイルは最大${MAX_ATTACHMENT_COUNT}件までです（現在${items.length}件）。`;
  }
  let total = 0;
  for (const item of items) {
    const filenameError = validateFilename(item.filename);
    if (filenameError) {
      return filenameError;
    }
    if (item.text.includes('\uFFFD')) {
      return `"${item.filename}" は有効な UTF-8 テキストではありません。`;
    }
    if (item.byteSize > MAX_ATTACHMENT_BYTES) {
      return `"${item.filename}" のサイズ（${formatBytes(item.byteSize)}）が上限（${formatBytes(MAX_ATTACHMENT_BYTES)}）を超えています。`;
    }
    total += item.byteSize;
  }
  if (total > MAX_TOTAL_ATTACHMENT_BYTES) {
    return `添付ファイルの合計サイズ（${formatBytes(total)}）が上限（${formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)}）を超えています。`;
  }
  return null;
}

/**
 * UTF-8 文字列を base64 へエンコードする。
 * Node のテストランナー（`node --import tsx --test`）には `Buffer` があるのでそちらを
 * 優先し、ブラウザ実行時（Buffer 未定義）は `btoa` へフォールバックする。
 */
function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Attachment[] を api.orchestrate() が要求するワイヤ形式へ変換する（順序を保持）。 */
export function toWireAttachments(
  items: readonly Attachment[]
): Array<{ filename: string; mimeType: AllowedAttachmentMimeType; content: string }> {
  return items.map((item) => ({
    filename: item.filename,
    mimeType: item.mimeType,
    content: utf8ToBase64(item.text),
  }));
}
