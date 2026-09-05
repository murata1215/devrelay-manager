/**
 * チャット入力へのテキスト添付（サイクル1.28、フェーズ1）。
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
 */

/** core の submit_instruction が受け付ける MIME（画像は非スコープ、フェーズ1はこの2つのみ）。 */
export const ALLOWED_ATTACHMENT_MIME_TYPES = ['text/plain', 'text/markdown'] as const;
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
  /** core へそのまま渡す base64（再エンコードしない。往復させて劣化させないため）。 */
  content: string;
  /** UTF-8 デコード済みの本文（buildAttachmentContext・プレビュー相当に使う）。 */
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
  | 'totalTooLarge';

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
 * base64 → UTF-8 文字列へデコードする。base64 として不正、または UTF-8 として不正な
 * バイト列（fatal decode で検出）のどちらかなら null を返す。
 * 呼び出し側（validateAttachments）がどちらのエラーかを区別できるよう、
 * この関数自体は「区別しない」設計にしてある（区別は isStrictBase64 を先に呼んで行う）。
 */
export function decodeAttachmentText(base64: string): string | null {
  if (!isStrictBase64(base64)) return null;
  const buf = Buffer.from(base64, 'base64');
  // 往復させて元の base64 と一致するか確認する（Buffer.from は不正な文字混入時でも
  // 例外を投げず静かに読み飛ばすことがあるため、この往復チェックが唯一の砦になる）。
  if (buf.toString('base64') !== base64) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    return null;
  }
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

/**
 * core の実測仕様（件数10・1ファイル5MB・合計10MB・MIME許可リスト）をそのまま鏡写しにした
 * クライアント側（この場合は manager server 側）検証。core へ届く前に読める理由で弾く。
 *
 * 検査順序: 件数 → 各アイテムの形式（itemInvalid/mimeNotAllowed/base64Invalid/notUtf8）→
 * 1ファイルサイズ（fileTooLarge）→ 合計サイズ（totalTooLarge）。
 * 最初に見つかったエラーだけを返す（no-silent-failure だが多重表示はしない）。
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
    if (!isStrictBase64(item.content)) {
      return {
        ok: false,
        code: 'base64Invalid',
        reason: `"${item.filename}" の内容が正しい base64 として解釈できません。`,
      };
    }
    const text = decodeAttachmentText(item.content);
    if (text === null) {
      return {
        ok: false,
        code: 'notUtf8',
        reason: `"${item.filename}" の内容が有効な UTF-8 テキストではありません。`,
      };
    }
    const byteSize = Buffer.byteLength(text, 'utf-8');
    if (byteSize > MAX_ATTACHMENT_BYTES) {
      return {
        ok: false,
        code: 'fileTooLarge',
        reason: `"${item.filename}" のサイズ（${byteSize} バイト）が上限（${MAX_ATTACHMENT_BYTES} バイト）を超えています。`,
      };
    }
    totalBytes += byteSize;
    decoded.push({ filename: item.filename.trim(), mimeType: item.mimeType, content: item.content, text, byteSize });
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

/** content（本文）＋ 添付全文の合計文字数。MAX_TOTAL_TEXT_CHARS との比較にのみ使う。 */
export function combinedTextLength(content: string, decoded: readonly Pick<DecodedAttachment, 'text'>[]): number {
  return content.length + decoded.reduce((sum, d) => sum + d.text.length, 0);
}

/**
 * 添付が空なら content をそのまま返す（1.27 以前と1バイトも変わらない後方互換）。
 * 非空なら見出し付きで全文をそのまま連結する（要約・切り詰めは一切しない＝spec §4 verbatim）。
 */
export function buildAttachmentContext(
  content: string,
  decoded: readonly Pick<DecodedAttachment, 'filename' | 'text'>[]
): string {
  if (decoded.length === 0) {
    return content;
  }
  const sections = decoded.map((d) => `--- 添付ファイル: ${d.filename} ---\n${d.text}`);
  return [content, ...sections].join('\n\n');
}
