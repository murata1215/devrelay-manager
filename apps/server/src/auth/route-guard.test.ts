import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { requiresAuth } from './route-guard.js';

test('176. requiresAuth: /threads・/dispatch/:id・/core/projects は保護対象', () => {
  assert.equal(requiresAuth('GET', '/threads'), true);
  assert.equal(requiresAuth('POST', '/threads'), true);
  assert.equal(requiresAuth('GET', '/threads/abc/messages'), true);
  assert.equal(requiresAuth('POST', '/dispatch/xyz/approve-target'), true);
  assert.equal(requiresAuth('GET', '/core/projects'), true);
});

test('177. requiresAuth: /health・静的配信・OPTIONS（プリフライト）は保護対象外', () => {
  assert.equal(requiresAuth('GET', '/health'), false);
  assert.equal(requiresAuth('GET', '/'), false);
  assert.equal(requiresAuth('GET', '/index.html'), false);
  assert.equal(requiresAuth('GET', '/assets/app.js'), false);
  assert.equal(requiresAuth('OPTIONS', '/threads'), false);
});

/**
 * 178. routes/*.ts に実際に定義されているルートパス文字列を走査し、/health 以外の
 * すべてのパスが requiresAuth(method, path) === true になることを機械確認する
 * （orchestrator-llm-structure.test.ts と同じ「新規ルート追加時の抜け漏れ検出」流儀）。
 */
test('178. requiresAuth: routes/*.ts の全ルート定義を走査し、/health 以外は必ず true になる', () => {
  const here = fileURLToPath(import.meta.url);
  const routesDir = join(dirname(here), '..', 'routes');
  const files = readdirSync(routesDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
  assert.ok(files.length > 0, 'routes ディレクトリにファイルが見つかりません。');

  // app.get('/path', ...) / app.post<...>('/path', ...) の1個目の文字列引数を拾う。
  const pattern = /app\.(get|post|put|patch|delete)(?:<[^>]*>)?\s*\(\s*'([^']+)'/g;
  const found: Array<{ file: string; method: string; path: string }> = [];
  for (const file of files) {
    const source = readFileSync(join(routesDir, file), 'utf-8');
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(source)) !== null) {
      found.push({ file, method: match[1], path: match[2] });
    }
  }
  assert.ok(found.length >= 10, `走査でルートが十分に見つかっていません（found=${found.length}）。`);

  for (const route of found) {
    // Fastify のパラメータ記法 :id はそのまま渡して問題ない（requiresAuth はプレフィックス判定のみ）。
    const expected = route.path !== '/health';
    assert.equal(
      requiresAuth(route.method.toUpperCase(), route.path),
      expected,
      `${route.file}: ${route.method} ${route.path} の判定が想定と異なります。`
    );
  }
});
