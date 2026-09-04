/**
 * 認証を要求するかどうかの判定（サイクル1.27 認証層）。
 *
 * 適用対象は「API ルート全体」。除外は GET /health と静的配信（/ 以下・/assets/* など）のみ。
 * プレフィックス許可リスト方式: 現行 API は /threads・/dispatch・/core の3系統しか存在しない
 * （routes/*.ts 参照）。新しい API 系統を足すときはここに追記が必要になる。
 * その網羅性は orchestrator-llm-structure.test.ts と同様に、テスト側でルート定義走査により
 * 機械的に検査する（route-guard.test.ts 参照）。
 *
 * OPTIONS は常に対象外にする — CORS プリフライトリクエストに Authorization ヘッダは付かない
 * ため、ここを保護対象にすると preflight が 401 になりブラウザの実リクエストが飛ばなくなる。
 */

const PROTECTED_PREFIXES = ['/threads', '/dispatch', '/core'];

export function requiresAuth(method: string, pathname: string): boolean {
  if (method.toUpperCase() === 'OPTIONS') {
    return false;
  }
  return PROTECTED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}
