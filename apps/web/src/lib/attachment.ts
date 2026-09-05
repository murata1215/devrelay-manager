/**
 * サイクル1.28: チャット入力へのテキスト添付（フェーズ1）の純粋ロジック。
 * サイクル1.35: 画像添付（フェーズ2）を追加。
 *
 * ここに置くのは「DOM に触れない」判定・変換関数のみ（他の lib/*.ts と同じ方針）。
 * Composer.tsx 側は onPaste/onDrop/onChange からこれらの関数を呼ぶだけにする。
 *
 * 上限値は server 側 `apps/server/src/orchestrator/attachment.ts` と手動で同期する
 * （types.ts と同じ「import で結ばず手動同期」方針。web と server は別ワークスペースで
 * ビルド成果物を共有しないため）。特に MAX_TOTAL_TEXT_CHARS の導出根拠（140,000 文字）は
 * server 側ファイルの冒頭コメントに全文を書いてあるので、変更時はそちらを正として参照すること。
 *
 * サイクル1.29: 「手動同期」が壊れても気づけるよう、attachment.test.ts にドリフト検出テスト
 * （#60）を追加した。server 側の定数値が変わったのにここを直し忘れると、そのテストが
 * server の attachment.ts をテキストとして読み取って値を突合し、確実に落ちる。
 * サイクル1.35: ALLOWED_IMAGE_MIME_TYPES にも同様のドリフト検出テストを追加した。
 *
 * 【サイクル1.35: 画像を orchestrator LLM へ渡さないための二重防壁（server 側と同じ設計）】
 * 1. Attachment.kind で text/image を判別し、画像は combinedTextLength／
 *    送信本文の構築（server 側 buildAttachmentContext）から除外する。
 * 2. 画像の Attachment.text は常に空文字 '' にする（base64 は base64 フィールドにしか
 *    入れない）。1 が万一漏れても本文へ画像内容が混入しない構造にする。
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

export type AllowedTextAttachmentMimeType = 'text/plain' | 'text/markdown';

/**
 * サイクル1.35: core #358 が実装済みの画像4形式（server 側 attachment.ts と同値。
 * こちらも「手動同期」方針でドリフト検出テストを持つ）。拡張子・宣言 MIME は信用せず、
 * 必ず detectImageMimeType でマジックバイトと突き合わせる。
 */
export const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

export type AllowedAttachmentMimeType = AllowedTextAttachmentMimeType | AllowedImageMimeType;

export interface Attachment {
  id: string;
  filename: string;
  mimeType: AllowedAttachmentMimeType;
  /**
   * サイクル1.35: text/image の判別子。server 側 DecodedAttachment.kind と同じ意味
   * （二重防壁の1枚目。詳細はファイル冒頭コメント参照）。
   */
  kind: 'text' | 'image';
  /**
   * デコード済みのテキスト本文（UI プレビュー・送信直前の base64 化に使う）。
   * kind === 'image' のときは常に空文字 '' にする（二重防壁の2枚目）。
   */
  text: string;
  /**
   * サイクル1.35: base64 エンコード済みの画像バイト（サムネイル表示・送信の両方に使う）。
   * kind === 'text' のときは常に空文字 ''。
   */
  base64: string;
  /** UTF-8（テキスト）またはデコード後の生バイト数（画像）。上限判定・UI 表示に使う。 */
  byteSize: number;
}

/**
 * core `submit_instruction` の attachments 1件が要求するワイヤ形式（サイクル1.28）。
 * サイクル1.29: `composer-send.ts` からも参照するため `Composer.tsx` 側の
 * `ReturnType<typeof toWireAttachments>[number]` 由来の型定義をやめてここへ集約した
 * （lib → components という逆向き依存を避けるため）。
 */
export interface WireAttachment {
  filename: string;
  mimeType: AllowedAttachmentMimeType;
  /** base64 エンコード済みの本文。 */
  content: string;
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

/** 拡張子から許可テキスト MIME タイプを決める（大文字小文字は無視）。該当なしは null（拒否）。 */
export function mimeTypeForFilename(name: string): AllowedTextAttachmentMimeType | null {
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

/**
 * サイクル1.35: 画像 MIME から拡張子を決める（`pasted-image.png` 等のファイル名生成に使う）。
 * 申告 MIME ではなく detectImageMimeType が実バイトから判定した MIME を渡すこと
 * （偽装された拡張子を再生産しないため）。
 */
export function imageExtensionForMimeType(mimeType: AllowedImageMimeType): string {
  switch (mimeType) {
    case 'image/png':
      return '.png';
    case 'image/jpeg':
      return '.jpg';
    case 'image/gif':
      return '.gif';
    case 'image/webp':
      return '.webp';
    default:
      return '';
  }
}

/**
 * サイクル1.35: 画像4形式のマジックバイト表で実際の形式を判定する（拡張子・宣言 MIME は
 * 信用しない）。server 側 `apps/server/src/orchestrator/attachment.ts` の
 * detectImageMimeType と同じ判定式（手動同期）。Buffer に依存せず Uint8Array のみで
 * 動くようにしてある（ブラウザ実行時に Buffer が無くても動く）。
 * - PNG:  89 50 4E 47 0D 0A 1A 0A（先頭8バイト固定シグネチャ）
 * - JPEG: FF D8 FF（先頭3バイト）
 * - GIF:  先頭6バイトが ASCII で "GIF87a" または "GIF89a"
 * - WebP: 先頭4バイトが "RIFF" かつ 8〜11バイト目が "WEBP"
 */
export function detectImageMimeType(bytes: Uint8Array): AllowedImageMimeType | null {
  function asciiEquals(offset: number, ascii: string): boolean {
    for (let i = 0; i < ascii.length; i += 1) {
      if (bytes[offset + i] !== ascii.charCodeAt(i)) return false;
    }
    return true;
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return 'image/jpeg';
  }
  if (bytes.length >= 6 && (asciiEquals(0, 'GIF87a') || asciiEquals(0, 'GIF89a'))) {
    return 'image/gif';
  }
  if (bytes.length >= 12 && asciiEquals(0, 'RIFF') && asciiEquals(8, 'WEBP')) {
    return 'image/webp';
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
 * 本文＋添付全文の合計文字数（UTF-16 code unit 長。JS の `string.length` と同じ数え方）。
 * サイクル1.29: server 側 `apps/server/src/orchestrator/attachment.ts` の
 * `combinedTextLength(content, decoded)` と完全に同じ定義にする（content.length + 各 text.length の和）。
 * server はこの値を `parsed.data.content`（= web が送る `content.trim()`）に対して評価するため、
 * 呼び出し側（validateAttachments）も trim 済みの本文を渡すこと。
 * サイクル1.35: kind === 'image' の添付は文字数に数えない（画像バイトは LLM 入力に含まれないため）。
 * kind が未指定の要素は従来どおりテキストとして扱う（後方互換）。
 */
export function combinedTextLength(
  content: string,
  items: readonly (Pick<Attachment, 'text'> & { kind?: Attachment['kind'] })[]
): number {
  return content.length + items.reduce((sum, item) => sum + (item.kind === 'image' ? 0 : item.text.length), 0);
}

/**
 * 添付一覧の妥当性を検証する。最初に見つかったエラーを読める理由文字列で返し、
 * すべて妥当なら null を返す。
 * - 件数は MAX_ATTACHMENT_COUNT 以下
 * - 各ファイル名は validateFilename を満たす
 * - UTF-8 として妥当（File.text() のデコード結果に \uFFFD が含まれていたら拒否。
 *   バイナリを .txt にリネームした場合を弾く）。サイクル1.35: kind === 'image' の添付は
 *   text が常に空文字のためこの検査の対象外にする（そもそも \uFFFD を含み得ない）。
 * - 各ファイルは MAX_ATTACHMENT_BYTES 以下（テキスト・画像とも対象）
 * - 合計は MAX_TOTAL_ATTACHMENT_BYTES 以下（テキスト・画像とも対象）
 * - サイクル1.29: `content`（送信予定の本文。省略時は空文字＝添付単体のサイズのみを見る）を
 *   加えた合計文字数が MAX_TOTAL_TEXT_CHARS 以下（server 側と同じ判定式・同じ上限値。
 *   ここで弾くのは「送信前にユーザーへ知らせる」ためのクライアント側チェックであり、
 *   server 側の拒否（routes/orchestrator.ts）を置き換えるものではない＝そちらも残る）。
 *   超過時も要約・切り詰めは行わない（拒否のみ）。サイクル1.35: 画像バイトはこの文字数上限に
 *   含めない（combinedTextLength が kind==='image' を除外するため自動的に達成される）。
 */
export function validateAttachments(items: readonly Attachment[], content = ''): string | null {
  if (items.length > MAX_ATTACHMENT_COUNT) {
    return `添付ファイルは最大${MAX_ATTACHMENT_COUNT}件までです（現在${items.length}件）。`;
  }
  let total = 0;
  for (const item of items) {
    const filenameError = validateFilename(item.filename);
    if (filenameError) {
      return filenameError;
    }
    if (item.kind !== 'image' && item.text.includes('\uFFFD')) {
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
  const textLength = combinedTextLength(content, items);
  if (textLength > MAX_TOTAL_TEXT_CHARS) {
    return (
      `本文と添付ファイルの合計文字数（${textLength}文字）が上限（${MAX_TOTAL_TEXT_CHARS}文字）を超えています。` +
      '添付を減らすか本文を短くしてください（要約・切り詰めは行いません）。'
    );
  }
  return null;
}

/**
 * サイクル1.35: 生バイト（Uint8Array）を base64 へエンコードする（画像用。utf8ToBase64 と
 * 同じ Buffer 優先／btoa フォールバックの流儀）。
 */
export function bytesToBase64(bytes: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/**
 * UTF-8 文字列を base64 へエンコードする。
 * Node のテストランナー（`node --import tsx --test`）には `Buffer` があるのでそちらを
 * 優先し、ブラウザ実行時（Buffer 未定義）は `btoa` へフォールバックする。
 */
function utf8ToBase64(text: string): string {
  return bytesToBase64(new TextEncoder().encode(text));
}

/**
 * Attachment[] を api.orchestrate() が要求するワイヤ形式へ変換する（順序を保持）。
 * サイクル1.35: kind === 'image' は既にエンコード済みの base64（item.base64）をそのまま使い、
 * 再エンコードしない（劣化・二重エンコードを避けるため。テキストは従来どおり item.text から
 * その都度 base64 化する）。
 */
export function toWireAttachments(items: readonly Attachment[]): WireAttachment[] {
  return items.map((item) => ({
    filename: item.filename,
    mimeType: item.mimeType,
    content: item.kind === 'image' ? item.base64 : utf8ToBase64(item.text),
  }));
}
