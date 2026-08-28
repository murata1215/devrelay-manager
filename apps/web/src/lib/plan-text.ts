/**
 * プラン本文（planMarkdown）からノイズ行を分離する（サイクル1.19 W2）。
 *
 * ノイズ行の判定: 行頭が 🔧 / 📊、または 'Rate Limit' / 'を使用中' を含む行。
 * これらの文字列はリポジトリ内には存在せず core の planMarkdown 由来のため、
 * 表示側（web）で分離する。
 */

/** splitPlanNoise の戻り値。body はノイズ除去後の本文、noise はノイズ行のみ。 */
export interface SplitPlanText {
  body: string;
  noise: string[];
}

/** 1行がノイズ行かどうかを判定する。 */
function isNoiseLine(line: string): boolean {
  return (
    line.startsWith('🔧') ||
    line.startsWith('📊') ||
    line.includes('Rate Limit') ||
    line.includes('を使用中')
  );
}

/** markdown をノイズ行と本文行に分離する。ノイズが無ければ body は原文と同一。 */
export function splitPlanNoise(markdown: string): SplitPlanText {
  const lines = markdown.split('\n');
  const bodyLines: string[] = [];
  const noise: string[] = [];
  for (const line of lines) {
    if (isNoiseLine(line)) {
      noise.push(line);
    } else {
      bodyLines.push(line);
    }
  }
  return { body: bodyLines.join('\n'), noise };
}
