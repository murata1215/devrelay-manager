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
 * 純粋モジュール：import は manager-settings.ts の型のみ（fs・DB・core に触れない）。
 */
import type { ManagerSettings } from './manager-settings.js';
import { assertRequiredClausesPresent } from './manager-settings.js';

/**
 * LLM が作文した本文（body）を governance テンプレで機械的に包む。
 *
 * body が空・空白のみなら throw する（no-silent-failure: 空の instruction を
 * テンプレだけで水増しして submit しない）。
 */
export function composeInstruction(body: string, settings: ManagerSettings): string {
  if (body.trim() === '') {
    throw new Error('instruction 本文が空です。governance テンプレのみでの submit はできません。');
  }
  return settings.governance.header + body + settings.governance.footer;
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
