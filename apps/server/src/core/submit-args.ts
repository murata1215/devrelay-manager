/**
 * submit_instruction へ渡す core MCP 呼び出し引数の組み立て（サイクル1.21 S7）。
 *
 * coreClient.ts は @modelcontextprotocol/sdk を import するため node の単体テストから
 * 直接叩くのに向かない。1.19 の approveImplementation の note と同じ流儀で、
 * 引数組み立てをこの import ゼロの純関数へ切り出す。
 *
 * 【重要・実測】core の submit_instruction の inputSchema は projectId/instruction の
 * 2つしか受け付けない（tools/list を実機 core MCP に問い合わせて確認、サイクル1.21）。
 * council を足しても core 側の挙動は現時点で変わらない（core は未知引数を静かに捨てる
 * ことを list_projects への実呼び出しで確認済み）。ここでは manager 側の記録・将来の
 * core 拡張に備えて引数を組み立てるところまでを行う。
 */

/**
 * council が true のときだけ council キーを足す。未指定/false のときは
 * 従来と完全同形の { projectId, instruction } を返す。
 */
export function buildSubmitInstructionArgs(
  projectId: string,
  instruction: string,
  council?: boolean
): Record<string, unknown> {
  const args: Record<string, unknown> = { projectId, instruction };
  if (council === true) {
    args.council = true;
  }
  return args;
}
