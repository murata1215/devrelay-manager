/**
 * 構造テスト（サイクル1.11 ③-3）: LLM 層のファイルが遷移経路・core RPC へ到達する
 * import を一切持たないことをソース文字列で機械検証する。
 *
 * orchestrator-llm.ts のファイル冒頭コメントで宣言した「担保の三重」のうち
 * 「2. import」を自動化する。将来うっかり禁止 import が増えたらこのテストが赤くなる。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

const LLM_LAYER_FILES = [
  'orchestrator-llm.ts',
  'governance.ts',
  'tier.ts',
  'project-proposal.ts',
  'draft-sink.ts',
];

const FORBIDDEN_SPECIFIER_FRAGMENTS = [
  'dispatch-state',
  'dispatch-store',
  'dispatch-gates',
  'dispatch-worker',
  'coreClient',
  'db/client',
];

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  const importRe = /import\s+(?:type\s+)?(?:[\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    specifiers.push(match[1]);
  }
  return specifiers;
}

test('99. 構造テスト: LLM 層5ファイルは遷移経路・core RPC への import を一切持たない', () => {
  for (const file of LLM_LAYER_FILES) {
    const path = resolve(here, file);
    const source = readFileSync(path, 'utf-8');
    const specifiers = importSpecifiers(source);
    for (const specifier of specifiers) {
      for (const forbidden of FORBIDDEN_SPECIFIER_FRAGMENTS) {
        assert.equal(
          specifier.includes(forbidden),
          false,
          `${file} が禁止 import "${forbidden}" を含む specifier "${specifier}" を import しています。`
        );
      }
    }
  }
});
