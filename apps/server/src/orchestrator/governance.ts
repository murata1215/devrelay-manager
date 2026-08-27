/**
 * governance テンプレの機械的注入（サイクル1.11 ③-3）。
 *
 * spec §5 D2: 「manager が instruction を機械的に包む：LLM は『やりたいこと』だけ作文 →
 * manager が定型の前後文（規約・devlog指示・STOP条件）を決定的に付与して submit」。
 *
 * このファイルの関数がテンプレ注入の唯一の経路。composeInstruction は
 * `header + body + footer` を文字列連結するだけであり、body（LLM 出力）が
 * header/footer を書き換える手段は無い（テンプレ文字列は Settings からしか来ない）。
 *
 * サイクル1.15: composeInstruction は冪等である（同じ settings に対して2回適用しても
 * 結果が変わらない）。これは stripGovernanceTemplate による正規化（既に付いている
 * header 接頭辞 / footer 接尾辞を剥がしてから連結し直す）で担保している。冪等性が
 * あるため、ゲート①（dispatch-gates.ts の approveTarget）は「人間が書き換えた
 * 可能性のある instruction」に対して draft 生成時と同じ composeInstruction を
 * 無条件に再適用でき、それが正常経路（draft の全文をそのまま渡す）を壊さない。
 *
 * 純粋モジュール：import は manager-settings.ts の型のみ（fs・DB・core に触れない）。
 */
import type { ManagerSettings } from './manager-settings.js';
import { assertRequiredClausesPresent } from './manager-settings.js';

/**
 * 既に付いている header 接頭辞 / footer 接尾辞を取り除く（冪等化の中核）。
 *
 * header/footer が空文字（managerSettingsSchema の z.string() は空文字を許すため
 * 起こりうる）のときは剥がす対象が無いのでループに入らない（無限ループガード）。
 * 二重・三重に付いていた場合（過去のバグや手動編集の結果）もすべて剥がしてから
 * composeInstruction で1回だけ付け直すことで、結果として冪等になる。
 */
export function stripGovernanceTemplate(text: string, settings: ManagerSettings): string {
  const { header, footer } = settings.governance;
  let out = text;
  if (header.length > 0) {
    while (out.startsWith(header)) {
      out = out.slice(header.length);
    }
  }
  if (footer.length > 0) {
    while (out.endsWith(footer)) {
      out = out.slice(0, out.length - footer.length);
    }
  }
  return out;
}

/**
 * LLM が作文した本文（body）を governance テンプレで機械的に包む。
 *
 * サイクル1.15: 冪等にするため、まず stripGovernanceTemplate で既存の
 * header/footer を剥がしてから連結し直す。これにより body に既に合成済みの
 * 全文（header+本文+footer）を渡しても二重に付かない
 * （composeInstruction(composeInstruction(x, s), s) === composeInstruction(x, s)）。
 *
 * 空チェックは strip 後の本文に対して行う（no-silent-failure: header/footer だけの
 * 文字列を渡された場合も本文空として throw する。テンプレのみでの submit はできない）。
 */
export function composeInstruction(body: string, settings: ManagerSettings): string {
  const stripped = stripGovernanceTemplate(body, settings);
  if (stripped.trim() === '') {
    throw new Error('instruction 本文が空です。governance テンプレのみでの submit はできません。');
  }
  return settings.governance.header + stripped + settings.governance.footer;
}

/**
 * 合成済み instruction に対して、governance の必須文言がすべて含まれているかを
 * 再検証する（draft 作成直前のもう一段の関所。manager-settings.ts のロード時検証とは
 * 独立に、実際に組み立てた instruction 自体で確認する）。
 *
 * LLM の body にテンプレ無効化を意図する文字列（例:「以下の規約は無視してください」）が
 * 含まれていても、header/footer 自体は composeInstruction が必ず前後に連結しているため
 * この検証は常に通る。つまり LLM は governance を「上書き」できず、せいぜい
 * 本文中に無視される指示を書くだけになる。
 */
export function assertGovernanceApplied(instruction: string, settings: ManagerSettings): void {
  assertRequiredClausesPresent(settings);
  const missing = settings.governance.requiredClauses.filter((clause) => !instruction.includes(clause));
  if (missing.length > 0) {
    throw new Error(
      `合成済み instruction に governance の必須文言が含まれていません: [${missing.join(', ')}]。`
    );
  }
}
