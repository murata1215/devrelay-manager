/**
 * submit_instruction へ渡す core MCP 呼び出し引数の組み立て（サイクル1.21 S7、1.28 で attachments 追加）。
 *
 * coreClient.ts は @modelcontextprotocol/sdk を import するため node の単体テストから
 * 直接叩くのに向かない。1.19 の approveImplementation の note と同じ流儀で、
 * 引数組み立てをこの import ゼロの純関数へ切り出す。
 *
 * 【重要・実測】core の submit_instruction の inputSchema（サイクル1.21 時点）は
 * projectId/instruction の2つしか受け付けなかった。council を足しても core 側の挙動は
 * 変わらない（core は未知引数を静かに捨てることを list_projects への実呼び出しで確認済み）。
 * 【重要・実測（サイクル1.28）】core #358 で attachments 引数が実装され、tools/list を
 * 実機 core MCP（http://127.0.0.1:3005/mcp）へ読み取り専用で問い合わせて確認した。
 * attachments の各要素は filename/mimeType/content の3キーのみを受け付ける（それ以外の
 * キー、たとえば manager 内部管理用の sortOrder 等は core へ渡してはいけない）。
 */

/** core の attachments 配列要素として渡してよい形（3キーのみ）。 */
export interface SubmitInstructionAttachment {
  filename: string;
  mimeType: string;
  content: string;
}

/**
 * council が true のときだけ council キーを足す。attachments が非空のときだけ
 * attachments キーを足す（3キーのみへ射影し、sortOrder 等の manager 内部情報は渡さない）。
 * どちらも未指定/空のときは従来と完全同形の { projectId, instruction } を返す。
 */
export function buildSubmitInstructionArgs(
  projectId: string,
  instruction: string,
  council?: boolean,
  attachments?: readonly SubmitInstructionAttachment[]
): Record<string, unknown> {
  const args: Record<string, unknown> = { projectId, instruction };
  if (council === true) {
    args.council = true;
  }
  if (attachments !== undefined && attachments.length > 0) {
    args.attachments = attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      content: a.content,
    }));
  }
  return args;
}
