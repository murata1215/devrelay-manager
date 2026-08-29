/**
 * orchestrate のリクエスト body 組み立て（サイクル1.21 W2）。
 *
 * apps/web/src/api.ts は import.meta.env に依存するため node のテストから
 * import できない（VITE_API_BASE が undefined になり TypeError で落ちる。
 * サイクル1.20 approve-plan-body.ts と同じ制約）。そのため body 組み立てを
 * この純関数へ切り出し、api.ts 側は薄いラッパに留める。
 */

/**
 * キー順は content → projectIds → council で固定する。
 * - projectIds は非空のときだけ含める（サイクル1.19 S1 と同じ扱い）。
 * - council は true のときだけ含める。false / 未指定ではキー自体を出さない
 *   ため、council OFF のリクエストはサイクル1.21 以前と1バイト同一になる。
 */
export function buildOrchestrateBody(content: string, projectIds?: string[], council?: boolean): string {
  const body: { content: string; projectIds?: string[]; council?: boolean } = { content };
  if (projectIds && projectIds.length > 0) {
    body.projectIds = projectIds;
  }
  if (council === true) {
    body.council = true;
  }
  return JSON.stringify(body);
}
