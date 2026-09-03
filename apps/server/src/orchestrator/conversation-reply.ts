/**
 * orchestrate() の結果から、manager Message として保存すべき本文を導出する純粋関数
 * （サイクル1.24）。
 *
 * 【背景】spec §9「純粋な会話は Dispatch を作らない」の枝で、LLM の返答が
 * HTTP レスポンス body にしか載らず DB に永続化されていなかった（1.24-pre で確定）。
 * web は orchestrate() のレスポンスを使わず reload()（DB 再取得）するだけなので、
 * DB に無い返答は画面にもタイムラインにも残らない。
 *
 * 【この関数のスコープ】DB 書き込みは一切行わない（呼び出し側の routes/orchestrator.ts が
 * prisma.message.create を呼ぶ）。ここでは「何を保存すべきか」の判定だけを純粋関数として
 * 切り出し、node --test で単体検証できるようにする（lib/orchestrate-body.ts 等と同じ流儀）。
 *
 * - kind: 'conversation' → LLM の reply をそのまま返す。
 * - kind: 'invalid'      → 定型文＋理由（無言 200 を解消し、ユーザーに何が起きたか見せる）。
 * - kind: 'proposal'     → null（Dispatch カードが出るので Message は作らない。二重表示防止）。
 */
import type { OrchestrateResult } from './orchestrator-llm.js';

/** invalid 時に返す定型文の見出し。理由（issues）は末尾に箇条書きで付記する。 */
export const INVALID_REPLY_HEAD =
  '指示を解釈できませんでした。もう一度、別の言い方でお試しください。';

/**
 * 保存すべき manager Message の本文を返す。保存不要（Dispatch 枝）なら null。
 */
export function managerReplyContent(result: OrchestrateResult): string | null {
  if (result.kind === 'conversation') {
    return result.reply;
  }
  if (result.kind === 'invalid') {
    if (result.issues.length === 0) {
      return INVALID_REPLY_HEAD;
    }
    return `${INVALID_REPLY_HEAD}\n\n理由:\n${result.issues.map((issue) => `- ${issue}`).join('\n')}`;
  }
  return null;
}
