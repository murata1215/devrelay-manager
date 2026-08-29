/**
 * approve-plan のリクエスト body 組み立て（サイクル1.20 W1）。
 *
 * apps/web/src/api.ts は import.meta.env に依存するため node のテストから
 * import できない（VITE_API_BASE が undefined になり TypeError で落ちる）。
 * そのため body 組み立てをこの純関数へ切り出し、api.ts 側は薄いラッパに留める。
 */

/**
 * note 未指定・空文字・空白のみのときは従来どおり `'{}'` を返す
 * （サイクル1.19以前と1バイト同一。サーバーの「明示時のみ patch に含める」方針と対）。
 * それ以外は note を trim して `{"note": "..."}` を返す。
 * サーバーの zod スキーマ（`note: z.string().optional()`）は空文字も受理して
 * DB 保存・core 伝播してしまうため、空を送らない責務をここで負う。
 */
export function buildApprovePlanBody(note?: string): string {
  const trimmed = note?.trim() ?? '';
  if (trimmed === '') {
    return '{}';
  }
  return JSON.stringify({ note: trimmed });
}
