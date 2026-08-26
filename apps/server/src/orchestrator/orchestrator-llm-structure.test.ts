/**
 * 構造テスト（サイクル1.11 ③-3 → サイクル1.12 で強化）: LLM 層のファイルが遷移経路・
 * core RPC へ到達する import を一切持たないことを機械検証する。
 *
 * orchestrator-llm.ts のファイル冒頭コメントで宣言した「担保の三重」のうち
 * 「2. import」を自動化する。
 *
 * サイクル1.11 版は正規表現 `import ... from '…'` のみを拾っており、以下がすり抜けた
 * （サイクル1.11 結果確認で申告した留保1）:
 *   - 副作用 import（`import 'x'`）
 *   - 動的 import（`await import('x')`）
 *   - `require('x')`
 *
 * サイクル1.12 では TypeScript Compiler API（`ts.createSourceFile`）で AST を構築し、
 * 上記に加えて re-export（`export ... from 'x'`）・`import x = require('x')` も含めて
 * 検出する。`typescript` は apps/server の既存 devDependency であり新規 npm 依存はゼロ
 * （テストファイルは tsconfig.json の exclude で本番ビルド対象外のため dist にも影響しない）。
 *
 * さらに「禁止モジュールへの到達が無いこと」に忠実に、エントリ5ファイルから相対 import を
 * 辿った推移閉包（transitive closure）の全ファイルを検査する。
 *
 * 動的 import()/require() の引数が文字列リテラルでない（変数・テンプレート結合等）場合は
 * 「静的に解決できない＝検査を迂回しうる」として無条件に fail させる（no-silent-failure）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname } from 'node:path';
import ts from 'typescript';

const here = dirname(fileURLToPath(import.meta.url));

const ENTRY_FILES = [
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
  // サイクル1.13: LLM 層は @anthropic-ai/sdk を直接 import しない（SDK を扱うのは
  // src/llm/anthropic-llm.ts のみ。この層は LlmPort インターフェースしか知らない）。
  '@anthropic-ai/sdk',
];

interface ScanResult {
  specifiers: string[];
  /**
   * 動的 import()/require() の引数が文字列リテラル（or テンプレートリテラルの
   * 単純形）でなく、静的にモジュール指定子を確定できない場合 true。
   */
  unresolvableDynamic: boolean;
}

function isStringLike(node: ts.Node): node is ts.StringLiteralLike {
  return ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

/**
 * ソース文字列から到達しうる全モジュール指定子を AST で抽出する純粋関数
 * （fs 等の I/O を持たない。テスト対象ファイルからも合成文字列からも呼べる）。
 *
 * 検出対象:
 *   - 静的 import（`import x from 's'` / 型 import / 副作用 import `import 's'`）
 *   - re-export（`export { x } from 's'` / `export * from 's'`）
 *   - 動的 import（`import('s')`）
 *   - `require('s')`
 *   - `import x = require('s')`
 */
function scanModuleSpecifiers(source: string, sourceFileName = 'source.ts'): ScanResult {
  const sourceFile = ts.createSourceFile(sourceFileName, source, ts.ScriptTarget.ES2022, true, ts.ScriptKind.TS);
  const specifiers: string[] = [];
  let unresolvableDynamic = false;

  function recordSpecifierExpression(expr: ts.Expression | undefined): void {
    if (expr && isStringLike(expr)) {
      specifiers.push(expr.text);
    } else {
      unresolvableDynamic = true;
    }
  }

  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      recordSpecifierExpression(node.moduleSpecifier as ts.Expression);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      recordSpecifierExpression(node.moduleSpecifier as ts.Expression);
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      recordSpecifierExpression(node.moduleReference.expression);
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequireCall = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequireCall) {
        recordSpecifierExpression(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return { specifiers, unresolvableDynamic };
}

/** 指定子リストのうち禁止フラグメントを含むものを列挙する。 */
function findForbidden(specifiers: readonly string[]): string[] {
  const hits: string[] = [];
  for (const specifier of specifiers) {
    for (const forbidden of FORBIDDEN_SPECIFIER_FRAGMENTS) {
      if (specifier.includes(forbidden)) {
        hits.push(`${specifier} (contains "${forbidden}")`);
      }
    }
  }
  return hits;
}

/**
 * 相対 specifier をファイルパスへ解決する。NodeNext ESM 規約に合わせ `.js` 指定を
 * `.ts` に読み替える。解決できない場合は throw する（黙ってスキップしない）。
 */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string {
  const base = resolve(dirname(fromFile), specifier);
  const candidate = extname(base) === '.js' ? `${base.slice(0, -3)}.ts` : `${base}.ts`;
  if (!existsSync(candidate)) {
    throw new Error(`相対 import "${specifier}"（from ${fromFile}）の解決先 "${candidate}" が見つかりません。`);
  }
  return candidate;
}

/** エントリファイル群から相対 import を辿った推移閉包（絶対パス一覧）を返す。 */
function transitiveClosure(entryFiles: readonly string[]): string[] {
  const visited = new Set<string>();
  const queue: string[] = entryFiles.map((f) => resolve(here, f));
  while (queue.length > 0) {
    const file = queue.shift();
    if (file === undefined || visited.has(file)) continue;
    visited.add(file);
    const source = readFileSync(file, 'utf-8');
    const { specifiers } = scanModuleSpecifiers(source, file);
    for (const specifier of specifiers) {
      if (specifier.startsWith('.')) {
        const resolved = resolveRelativeSpecifier(file, specifier);
        if (!visited.has(resolved)) {
          queue.push(resolved);
        }
      }
    }
  }
  return [...visited];
}

test('99. 構造テスト: LLM 層の推移閉包（AST）は遷移経路・core RPC への import を一切持たない', () => {
  const closure = transitiveClosure(ENTRY_FILES);
  assert.ok(closure.length >= ENTRY_FILES.length, '推移閉包が空/縮退していません。');
  for (const file of closure) {
    const source = readFileSync(file, 'utf-8');
    const { specifiers, unresolvableDynamic } = scanModuleSpecifiers(source, file);
    assert.equal(
      unresolvableDynamic,
      false,
      `${file} に静的解決できない動的 import()/require() があります（迂回封じのため fail）。`
    );
    const hits = findForbidden(specifiers);
    assert.deepEqual(hits, [], `${file} が禁止 import を含みます: ${hits.join(', ')}`);
  }
});

test('102. scanModuleSpecifiers: 副作用 import（import "x"）を検出する', () => {
  const source = `import './dispatch-store.js';\nexport const x = 1;\n`;
  const { specifiers } = scanModuleSpecifiers(source);
  const hits = findForbidden(specifiers);
  assert.ok(hits.length > 0, '副作用 import が検出されていません。');
});

test('103. scanModuleSpecifiers: 動的 import（await import(...)）を検出する', () => {
  const source = `export async function f() {\n  const m = await import('./dispatch-gates.js');\n  return m;\n}\n`;
  const { specifiers, unresolvableDynamic } = scanModuleSpecifiers(source);
  assert.equal(unresolvableDynamic, false);
  const hits = findForbidden(specifiers);
  assert.ok(hits.length > 0, '動的 import が検出されていません。');
});

test('104. scanModuleSpecifiers: require(...) を検出する', () => {
  const source = `const client = require('../db/client.js');\nexport { client };\n`;
  const { specifiers } = scanModuleSpecifiers(source);
  const hits = findForbidden(specifiers);
  assert.ok(hits.length > 0, 'require() が検出されていません。');
});

test('105. scanModuleSpecifiers: export...from / import = require(...) を検出する', () => {
  const reExportSource = `export * from './dispatch-state.js';\n`;
  const importEqualsSource = `import coreClient = require('./coreClient.js');\nexport { coreClient };\n`;
  const reExportHits = findForbidden(scanModuleSpecifiers(reExportSource).specifiers);
  const importEqualsHits = findForbidden(scanModuleSpecifiers(importEqualsSource).specifiers);
  assert.ok(reExportHits.length > 0, 're-export が検出されていません。');
  assert.ok(importEqualsHits.length > 0, 'import = require() が検出されていません。');
});

test('106. scanModuleSpecifiers: 動的 import の引数が非リテラルなら解析不能として fail 扱いになる', () => {
  const source = `export async function f(name: string) {\n  return await import(name);\n}\n`;
  const { unresolvableDynamic } = scanModuleSpecifiers(source);
  assert.equal(unresolvableDynamic, true, '非リテラルな動的 import が見逃されています（迂回可能）。');
});

test('107. scanModuleSpecifiers: 正常な指定子（zod / node:fs / ./tier.js）は誤検出しない', () => {
  const source = `import { z } from 'zod';\nimport { readFileSync } from 'node:fs';\nimport type { Tier } from './tier.js';\n`;
  const { specifiers, unresolvableDynamic } = scanModuleSpecifiers(source);
  assert.equal(unresolvableDynamic, false);
  assert.deepEqual(findForbidden(specifiers), []);
});

test('108. scanModuleSpecifiers: 実ファイル governance.ts のソースに3形式を混入させると検出される（ディスクは汚さない）', () => {
  const realSource = readFileSync(resolve(here, 'governance.ts'), 'utf-8');
  const contaminated =
    `import './dispatch-store.js';\n` +
    `const c = require('../db/client.js');\n` +
    `async function _f() { await import('./dispatch-gates.js'); }\n` +
    realSource;
  const { specifiers, unresolvableDynamic } = scanModuleSpecifiers(contaminated);
  assert.equal(unresolvableDynamic, false);
  const hits = findForbidden(specifiers);
  assert.ok(
    hits.length >= 3,
    `実ファイルへの混入3形式が全て検出されていません（検出数: ${hits.length}）。`
  );
});

test('120. scanModuleSpecifiers: @anthropic-ai/sdk の import を混入させた合成ソースが検出される（サイクル1.13 実LLM結線。実閉包は #99 でグリーンのまま）', () => {
  const source = `import Anthropic from '@anthropic-ai/sdk';\nexport const x = 1;\n`;
  const { specifiers } = scanModuleSpecifiers(source);
  const hits = findForbidden(specifiers);
  assert.ok(hits.length > 0, '@anthropic-ai/sdk の import が検出されていません。');
});
