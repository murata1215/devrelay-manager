/**
 * サイクル1.29: 送信成否に応じて Composer の入力状態をどう遷移させるかの純粋ロジック。
 *
 * 背景: 1.28 では `Composer.handleSend` が `await onSend(...)` の成否に関わらず
 * `setContent('')` / `setAttachments([])` を実行していたため、送信失敗時に本文・添付が
 * 消えてしまい、長文をペーストして添付化した直後にエラーが出ると貼り直しになっていた。
 *
 * web のテストは DOM 無し（`node --import tsx --test`）で動くため、React コンポーネントを
 * 直接テストできない（リポジトリ全体の慣習）。そこで「成功ならクリア・失敗なら保持」という
 * 判断そのものをこの純関数へ切り出し、Composer.tsx は戻り値をそのまま setState するだけにする。
 */
import type { Attachment, WireAttachment } from './attachment.js';
import { toWireAttachments } from './attachment.js';

/** Composer の送信まわりの状態（入力欄の生テキスト・添付一覧・エラー1行）。 */
export interface ComposerSendState {
  content: string;
  attachments: readonly Attachment[];
  error: string | null;
}

/**
 * 送信を1回試みて、次の状態を返す。
 * - 成功時: content は空文字、attachments は空配列、error は null になる。
 * - 失敗時: content・attachments（順序含む）はすべて呼び出し時のまま保持され、
 *   error に読める理由が入る。ネットワークエラー・core からの検証エラー・
 *   manager 側の上限超過（400）のいずれの失敗経路でも同じ扱いになる
 *   （`send` が reject した理由を区別せず一律で保持するため）。
 * - `send` へ渡す本文は trim 済み、添付は wire 形式（filename/mimeType/content(base64)）。
 *   ただし失敗時に state へ戻す `content` は trim 前の元の値（末尾の改行等も失わない）。
 */
export async function performSend(
  state: ComposerSendState,
  send: (content: string, attachments: WireAttachment[]) => Promise<void>
): Promise<ComposerSendState> {
  try {
    await send(state.content.trim(), toWireAttachments(state.attachments));
    return { content: '', attachments: [], error: null };
  } catch (err) {
    return { content: state.content, attachments: state.attachments, error: describeSendError(err) };
  }
}

/**
 * 送信失敗の例外から表示用の1行を作る。
 * `ApiError`（apps/web/src/api.ts）は `Error` を継承しているため `instanceof Error` で
 * message を取り出せる。`api.ts` は `import.meta.env` に依存し node のテストから
 * import できないため、ここでは `ApiError` を直接 import しない（型として要求もしない）。
 */
export function describeSendError(err: unknown): string {
  const detail = err instanceof Error ? err.message : String(err);
  return `送信に失敗しました: ${detail}（本文と添付は保持しています。修正して再送信できます）`;
}

/**
 * orchestrate が 404（DISPATCH_WORKER_MODE=off で未提供）だったとき、
 * 「本文だけメッセージとして記録するフォールバック」へ落ちてよいか。
 *
 * サイクル1.28 は添付の有無に関わらずこのフォールバックへ進み、添付がある場合は
 * 黙って捨てて `（添付は記録されませんでした）` と info 表示するだけだった。
 * これは「送信失敗で入力を失わせない」という本サイクルの目的と逆行するため、
 * 添付が1件でもある場合はフォールバックせずエラーとして扱い、本文・添付を丸ごと
 * 保持する（Message 行も作らないので、保持した内容で再送しても二重投稿にならない）。
 * 添付が無い場合（count === 0）は失うものが無いため 1.28 の挙動を維持する。
 */
export function canFallbackToMessageOnly(status: number, attachmentCount: number): boolean {
  return status === 404 && attachmentCount === 0;
}
