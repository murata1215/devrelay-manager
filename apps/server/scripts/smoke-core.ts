/**
 * core MCP アダプタの read-only スモークテスト。
 *
 * 実行対象は listProjects() のみ（submit/approve/build 系は実ビルドを誘発するため叩かない）。
 * PAT・接続文字列は一切出力しない。
 *
 * 使い方: pnpm smoke:core
 */
import 'dotenv/config';
import { listProjects } from '../src/core/coreClient.js';

async function main() {
  console.log('[smoke-core] listProjects() を呼び出します...');

  const projects = await listProjects();

  if (!Array.isArray(projects)) {
    throw new Error(`listProjects() が配列を返しませんでした（型: ${typeof projects}）`);
  }
  console.log(`[smoke-core] OK: 配列を取得（件数: ${projects.length}）`);

  if (projects.length === 0) {
    throw new Error('listProjects() の件数が0件でした（少なくとも1件を期待）');
  }

  const sample = projects[0];
  const requiredKeys = ['id', 'name', 'online'] as const;
  for (const key of requiredKeys) {
    if (!(key in sample)) {
      throw new Error(`要素に必須キー "${key}" がありません。実際のキー: ${Object.keys(sample).join(',')}`);
    }
  }
  console.log(`[smoke-core] OK: 要素が id/name/online を保持（例: id/name/online 型は ${typeof sample.id}/${typeof sample.name}/${typeof sample.online}）`);

  console.log('[smoke-core] すべてのアサーションに成功しました。');
  process.exit(0);
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[smoke-core] 失敗: ${message}`);
  process.exit(1);
});
