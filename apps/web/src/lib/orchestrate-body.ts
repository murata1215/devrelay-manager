/**
 * orchestrate のリクエスト body 組み立て（サイクル1.21 W2）。
 *
 * apps/web/src/api.ts は import.meta.env に依存するため node のテストから
 * import できない（VITE_API_BASE が undefined になり TypeError で落ちる。
 * サイクル1.20 approve-plan-body.ts と同じ制約）。そのため body 組み立てを
 * この純関数へ切り出し、api.ts 側は薄いラッパに留める。
 */

/** サイクル1.28: attachments の wire 形式（server routes/orchestrator.ts の zod と同形）。 */
export interface OrchestrateAttachment {
  filename: string;
  mimeType: string;
  content: string;
}

/**
 * キー順は content → projectIds → council → attachments で固定する。
 * - projectIds は非空のときだけ含める（サイクル1.19 S1 と同じ扱い）。
 * - council は true のときだけ含める。false / 未指定ではキー自体を出さない
 *   ため、council OFF のリクエストはサイクル1.21 以前と1バイト同一になる。
 * - attachments は非空のときだけ含める（サイクル1.28）。未指定/空配列なら
 *   1.27 以前と1バイトも変わらない JSON になる。
 */
export function buildOrchestrateBody(
  content: string,
  projectIds?: string[],
  council?: boolean,
  attachments?: OrchestrateAttachment[]
): string {
  const body: {
    content: string;
    projectIds?: string[];
    council?: boolean;
    attachments?: OrchestrateAttachment[];
  } = { content };
  if (projectIds && projectIds.length > 0) {
    body.projectIds = projectIds;
  }
  if (council === true) {
    body.council = true;
  }
  if (attachments && attachments.length > 0) {
    body.attachments = attachments;
  }
  return JSON.stringify(body);
}
