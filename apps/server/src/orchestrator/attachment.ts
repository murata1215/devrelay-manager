/**
 * チャット入力へのテキスト添付（サイクル1.28、フェーズ1）／画像添付（サイクル1.35、フェーズ2）。
 *
 * 【境界】orchestrator-llm.ts（構造テスト #99 のエントリファイル）から import されるため、
 * この層と同じ制約を守る — dispatch-state/dispatch-store/dispatch-gates/dispatch-worker/
 * core/coreClient/db/client/@anthropic-ai/sdk のいずれも import しない純関数のみで構成する。
 *
 * この層がやること／やらないこと:
 * - core の submit_instruction attachments パラメータに載せる前の検証・デコードのみを行う。
 * - instruction 本文（governance 適用済みの composeInstruction の結果）には一切触れない。
 *   添付は buildAttachmentContext() で LLM への入力文字列にのみ verbatim で連結する
 *   （spec §5: Agent への instruction には展開しない。仕様は buildAttachmentContext の
 *   呼び出し元である orchestrator-llm.ts 側の使い分けで担保する）。
 *
 * 【サイクル1.35: 画像添付を orchestrator LLM へ渡さないための二重防壁】
 * 1. DecodedAttachment.kind で text/image を判別し、buildAttachmentContext は
 *    kind === 'image' のものを本文へ一切連結しない（画像はファイル名・MIME・件数の
 *    メタ情報1行のみを付与する）。
 * 2. 画像の DecodedAttachment.text は常に空文字 '' にする（base64 は content にしか
 *    入れない）。1 が万一漏れても、連結対象の text が空文字である限り画像内容が
 *    本文へ混入することは構造上起こり得ない（fail-safe）。
 */

/** フェーズ1のテキスト2種（変更なし）。 */
export const ALLOWED_TEXT_ATTACHMENT_MIME_TYPES = ['text/plain', 'text/markdown'] as const;
export type AllowedTextAttachmentMimeType = (typeof ALLOWED_TEXT_ATTACHMENT_MIME_TYPES)[number];

/**
 * サイクル1.35: core #358 が実装済みの画像4形式（実機 core MCP へ tools/list を
 * 読み取り専用で問い合わせて確認済み。1.28 の attachments 引数追加と同じ経路）。
 * 拡張子・申告 MIME は信用せず、必ず detectImageMimeType でマジックバイトと突き合わせる。
 */
export const ALLOWED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
export type AllowedImageMimeType = (typeof ALLOWED_IMAGE_MIME_TYPES)[number];

/** core の submit_instruction が受け付ける MIME の全体（テキスト2種＋画像4種）。 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = [
  ...ALLOWED_TEXT_ATTACHMENT_MIME_TYPES,
  ...ALLOWED_IMAGE_MIME_TYPES,
] as const;
export type AllowedAttachmentMimeType = (typeof ALLOWED_ATTACHMENT_MIME_TYPES)[number];

/**
 * core MCP の tools/list を実機（http://127.0.0.1:3005/mcp）へ読み取り専用で問い合わせて
 * 実測した値（サイクル1.28）。submit_instruction.attachments の description に明記されている:
 * "Optional file attachments (max 10 files, 5MB each, 10MB total)."
 * MB の進数（10進/2進）が明記されていないため、境界で core 側の 413 に引っ掛からないよう
 * 厳しい側（10進）を採用する。
 */
export const MAX_ATTACHMENT_COUNT = 10;
export const MAX_ATTACHMENT_BYTES = 5_000_000;
export const MAX_TOTAL_ATTACHMENT_BYTES = 10_000_000;

/**
 * manager 独自の追加ガード: 添付を含む user content（本文＋添付全文）の合計文字数上限。
 *
 * 「なんとなく」の値ではなく、以下の実測・設定値から逆算する
 * （出典: https://platform.claude.com/docs/en/models/overview、2026-09-05 取得。
 * config/manager-settings.json の tierModels 参照）。
 *
 * 1. manager が使う3モデルのうちコンテキストウィンドウが最小なのは light tier の
 *    claude-haiku-4-5-20251001 で 200,000 トークン（heavy/standard の claude-opus-5 /
 *    claude-sonnet-5 は 1,000,000 トークン）。attachments 検証の時点ではまだ tier が
 *    確定しない（tier 解決は orchestrate() 内部の resolveTier）ため、常に最小値
 *    200,000 トークンを前提にする（安全側）。
 * 2. 出力用に config/manager-settings.json の llm.maxTokens = 8192 を確保する。
 * 3. system prompt（候補プロジェクト一覧・JSON スキーマ指示）用の余白として
 *    10,000 トークンを確保する（プロジェクト数が増えても壊れない余裕を持たせた値）。
 * 4. 残り 200,000 - 8,192 - 10,000 = 181,808 トークンを user content（本文＋添付全文）
 *    の予算とする。
 * 5. トークン→文字数の変換は「1トークン=1文字」という最も厳しい側を仮定する。
 *    公式ドキュメントは 1,000,000 トークンの窓について「約250万 Unicode 文字
 *    （1トークンあたり2.5文字）」という比率を示しているが、これは主に英語向けの目安であり、
 *    本 manager は日本語主体の入力を扱う（1文字あたりのトークン密度が高くなりやすい）ため、
 *    より保守的な密度（1文字1トークン）を採用し予算を過大評価しないようにする。
 * 6. 見積り誤差に対する20%の安全マージンを掛ける: 181,808 * 0.8 ≈ 145,446。
 * 7. きりの良い値へ切り下げて 140,000 文字を採用する。
 *
 * この上限を超えた場合は spec §4（verbatim・要約や切り詰め禁止）を守るため、
 * 黙って切り詰めるのではなく必ず拒否する（呼び出し側が読める理由付きで 400 を返す）。
 */
export const MAX_TOTAL_TEXT_CHARS = 140_000;

/** core へ渡す形そのもの（filename/mimeType/content の3キーのみ、content は base64）。 */
export interface AttachmentInput {
  filename: string;
  mimeType: string;
  content: string;
}

/** デコード・検証済みの添付（LLM への連結・core への再送信の両方に使う）。 */
export interface DecodedAttachment {
  filename: string;
  mimeType: string;
  /**
   * サイクル1.35: text/image の判別子。buildAttachmentContext・combinedTextLength は
   * この値で画像を除外する（二重防壁の1枚目。詳細はファイル冒頭コメント参照）。
   */
  kind: 'text' | 'image';
  /** core へそのまま渡す base64（再エンコードしない。往復させて劣化させないため）。 */
  content: string;
  /**
   * UTF-8 デコード済みの本文（buildAttachmentContext・プレビュー相当に使う）。
   * kind === 'image' のときは常に空文字 '' にする（二重防壁の2枚目）。
   */
  text: string;
  /** デコード後の生バイト数。 */
  byteSize: number;
}

export type AttachmentErrorCode =
  | 'tooMany'
  | 'itemInvalid'
  | 'mimeNotAllowed'
  | 'base64Invalid'
  | 'notUtf8'
  | 'fileTooLarge'
  | 'totalTooLarge'
  /** サイクル1.35: 申告 MIME と実バイトのマジックバイトが一致しない（拡張子・MIME 偽装）。 */
  | 'mimeMismatch';

export type AttachmentValidationResult =
  | { ok: true; decoded: DecodedAttachment[] }
  | { ok: false; code: AttachmentErrorCode; reason: string };

/** 標準 base64（改行・空白なし、A-Za-z0-9+/ と末尾 0〜2個の = のみ）かどうかを厳密に検査する。 */
function isStrictBase64(value: string): boolean {
  if (value.length === 0) return false;
  if (value.length % 4 !== 0) return false;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

/**
 * base64 → 生バイト（Buffer）へデコードする。base64 として不正なら null を返す。
 * サイクル1.35: テキスト・画像の両方で共有する「base64 妥当性チェック」をここへ集約した
 * （従来 decodeAttachmentText に埋め込まれていたロジックを、画像枝からも使えるよう独立させた。
 * decodeAttachmentText の公開シグネチャ・挙動は1バイトも変えていない）。
 */
function decodeAttachmentBuffer(base64: string): Buffer | null {
  if (!isStrictBase64(base64)) return null;
  const buf = Buffer.from(base64, 'base64');
  // 往復させて元の base64 と一致するか確認する（Buffer.from は不正な文字混入時でも
  // 例外を投げず静かに読み飛ばすことがあるため、この往復チェックが唯一の砦になる）。
  if (buf.toString('base64') !== base64) return null;
  return buf;
}

/** UTF-8 として fatal decode する（不正なバイト列なら null）。 */
function decodeUtf8Fatal(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/**
 * base64 → UTF-8 文字列へデコードする。base64 として不正、または UTF-8 として不正な
 * バイト列（fatal decode で検出）のどちらかなら null を返す。
 * 呼び出し側（validateAttachments）がどちらのエラーかを区別できるよう、
 * この関数自体は「区別しない」設計にしてある（区別は isStrictBase64 を先に呼んで行う）。
 */
export function decodeAttachmentText(base64: string): string | null {
  const buf = decodeAttachmentBuffer(base64);
  if (buf === null) return null;
  return decodeUtf8Fatal(buf);
}

/**
 * サイクル1.35: 画像4形式のマジックバイト表で実際の形式を判定する（拡張子・申告 MIME は
 * 信用しない）。新規 npm パッケージは使わず手書きのバイト比較のみで行う。
 * - PNG:  89 50 4E 47 0D 0A 1A 0A（先頭8バイト固定シグネチャ）
 * - JPEG: FF D8 FF（先頭3バイト。JFIF/EXIF いずれの派生も共通）
 * - GIF:  先頭6バイトが ASCII で "GIF87a" または "GIF89a"
 * - WebP: 先頭4バイトが "RIFF" かつ 8〜11バイト目が "WEBP"（RIFF コンテナ）
 */
export function detectImageMimeType(buf: Buffer): AllowedImageMimeType | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 6 && (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a')) {
    return 'image/gif';
  }
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
    return 'image/webp';
  }
  return null;
}

/** ファイル名が basename として妥当か（空・空白のみ・.  / .. ・区切り文字混入・255バイト超を拒否）。 */
function isValidAttachmentFilename(name: string): boolean {
  const trimmed = name.trim();
  if (trimmed.length === 0) return false;
  if (trimmed === '.' || trimmed === '..') return false;
  if (trimmed.includes('/') || trimmed.includes('\\')) return false;
  if (Buffer.byteLength(trimmed, 'utf-8') > 255) return false;
  return true;
}

function isAllowedMimeType(mimeType: string): mimeType is AllowedAttachmentMimeType {
  return (ALLOWED_ATTACHMENT_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** サイクル1.35: 申告 MIME が画像4形式のいずれかかどうか（テキスト枝／画像枝の分岐に使う）。 */
function isImageMimeType(mimeType: string): mimeType is AllowedImageMimeType {
  return (ALLOWED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

/**
 * core の実測仕様（件数10・1ファイル5MB・合計10MB・MIME許可リスト）をそのまま鏡写しにした
 * クライアント側（この場合は manager server 側）検証。core へ届く前に読める理由で弾く。
 *
 * 検査順序: 件数 → 各アイテムの形式（itemInvalid）→ MIME許可（mimeNotAllowed）→
 * base64妥当性（base64Invalid、テキスト・画像共通）→ テキストは UTF-8（notUtf8）／
 * 画像はマジックバイト突き合わせ（mimeMismatch）→ 1ファイルサイズ（fileTooLarge）→
 * 合計サイズ（totalTooLarge）。最初に見つかったエラーだけを返す（多重表示はしない）。
 *
 * サイクル1.35: 画像は UTF-8 デコードを一切経由しない（バイナリを文字列化しない）。
 * byteSize は base64 デコード後の生バイト数（buf.length）で、テキスト・画像とも同じ
 * 計算式にした（テキストの場合、fatal decode を通した UTF-8 文字列の再エンコードと
 * base64 デコード直後のバイト列は常に一致するため、従来の Buffer.byteLength(text,'utf-8')
 * と数値は完全に同じになる＝後方互換）。
 */
export function validateAttachments(items: AttachmentInput[]): AttachmentValidationResult {
  if (items.length > MAX_ATTACHMENT_COUNT) {
    return {
      ok: false,
      code: 'tooMany',
      reason: `添付ファイルは最大 ${MAX_ATTACHMENT_COUNT} 件までです（${items.length} 件が指定されました）。`,
    };
  }

  const decoded: DecodedAttachment[] = [];
  let totalBytes = 0;

  for (const item of items) {
    if (
      typeof item.filename !== 'string' ||
      typeof item.mimeType !== 'string' ||
      typeof item.content !== 'string' ||
      !isValidAttachmentFilename(item.filename) ||
      item.content.length === 0
    ) {
      return {
        ok: false,
        code: 'itemInvalid',
        reason: `添付ファイル名が不正です: "${item.filename}"（空・空白のみ・"."・".."・"/"・"\\" を含む名前や255バイトを超える名前は使えません）。`,
      };
    }
    if (!isAllowedMimeType(item.mimeType)) {
      return {
        ok: false,
        code: 'mimeNotAllowed',
        reason: `"${item.filename}" の MIME タイプ "${item.mimeType}" は許可されていません（許可: ${ALLOWED_ATTACHMENT_MIME_TYPES.join(', ')}）。`,
      };
    }
    const buf = decodeAttachmentBuffer(item.content);
    if (buf === null) {
      return {
        ok: false,
        code: 'base64Invalid',
        reason: `"${item.filename}" の内容が正しい base64 として解釈できません。`,
      };
    }

    let kind: 'text' | 'image';
    let text: string;
    if (isImageMimeType(item.mimeType)) {
      // サイクル1.35: 拡張子・申告 MIME は信用せず、実バイトのマジックバイトと必ず突き合わせる。
      const detected = detectImageMimeType(buf);
      if (detected === null || detected !== item.mimeType) {
        return {
          ok: false,
          code: 'mimeMismatch',
          reason: `"${item.filename}" の実際のバイト内容が申告された MIME タイプ "${item.mimeType}" と一致しません（拡張子や MIME の偽装は許可されません）。`,
        };
      }
      kind = 'image';
      // 二重防壁の2枚目: 画像の text は必ず空文字にする（buildAttachmentContext のフィルタ漏れが
      // あっても本文へ画像内容が混入しない構造にする）。
      text = '';
    } else {
      const decodedText = decodeUtf8Fatal(buf);
      if (decodedText === null) {
        return {
          ok: false,
          code: 'notUtf8',
          reason: `"${item.filename}" の内容が有効な UTF-8 テキストではありません。`,
        };
      }
      kind = 'text';
      text = decodedText;
    }

    const byteSize = buf.length;
    if (byteSize > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        code: 'fileTooLarge',
        reason: `"${item.filename}" のサイズ（${byteSize} バイト）が上限（${MAX_ATTACHMENT_BYTES} バイト）を超えています。`,
      };
    }
    totalBytes += byteSize;
    decoded.push({ filename: item.filename.trim(), mimeType: item.mimeType, kind, content: item.content, text, byteSize });
  }

  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    return {
      ok: false,
      code: 'totalTooLarge',
      reason: `添付ファイルの合計サイズ（${totalBytes} バイト）が上限（${MAX_TOTAL_ATTACHMENT_BYTES} バイト）を超えています。`,
    };
  }

  return { ok: true, decoded };
}

/**
 * content（本文）＋ 添付全文の合計文字数。MAX_TOTAL_TEXT_CHARS との比較にのみ使う。
 * サイクル1.35: kind === 'image' の添付は画像バイトを文字数として数えない（画像は base64 の
 * まま core へ渡すだけで、この文字数上限は「LLM への入力文字数」の見積りのためのものであり、
 * 画像は LLM 入力に含まれないため）。kind が未指定（1.28以前の呼び出し形）の要素は
 * 従来どおりテキストとして扱う（後方互換）。
 */
export function combinedTextLength(
  content: string,
  decoded: readonly (Pick<DecodedAttachment, 'text'> & { kind?: DecodedAttachment['kind'] })[]
): number {
  return content.length + decoded.reduce((sum, d) => sum + (d.kind === 'image' ? 0 : d.text.length), 0);
}

/**
 * 添付が空なら content をそのまま返す（1.27 以前と1バイトも変わらない後方互換）。
 * 非空ならテキスト添付は見出し付きで全文をそのまま連結する（要約・切り詰めは一切しない
 * ＝spec §4 verbatim）。
 *
 * サイクル1.35: 画像添付（kind === 'image'）は本文へ一切連結しない
 * （画像本体を orchestrator LLM へ渡さないという設計上の最重要制約）。画像が1件以上あるときだけ
 * 末尾に「ファイル名・MIME・件数」のメタ情報1行を足す（base64・画像内容は含めない）。
 * kind が未指定（1.28以前の呼び出し形）の要素は従来どおりテキストとして連結する（後方互換）。
 * 画像0件（またはすべて未指定＝テキスト扱い）なら 1.28〜1.33 と1バイトも変わらない出力になる。
 */
export function buildAttachmentContext(
  content: string,
  decoded: readonly (Pick<DecodedAttachment, 'filename' | 'text'> & {
    kind?: DecodedAttachment['kind'];
    mimeType?: string;
  })[]
): string {
  if (decoded.length === 0) {
    return content;
  }
  const textSections = decoded
    .filter((d) => d.kind !== 'image')
    .map((d) => `--- 添付ファイル: ${d.filename} ---\n${d.text}`);
  const images = decoded.filter((d) => d.kind === 'image');
  const sections = [...textSections];
  if (images.length > 0) {
    const detail = images.map((d) => `${d.filename} [${d.mimeType ?? ''}]`).join(', ');
    sections.push(`--- 画像添付: ${images.length}件（${detail}）---`);
  }
  if (sections.length === 0) {
    return content;
  }
  return [content, ...sections].join('\n\n');
}
