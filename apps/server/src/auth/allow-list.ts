/**
 * manager 利用許可ユーザーの判定（サイクル1.27 認証層）。
 *
 * MANAGER_ALLOWED_USER_IDS はカンマ区切りの core user id リスト。
 * 空（未設定・空文字・空白のみ）の場合は「誰も許可しない」— fail-closed。
 * 環境変数の読み出し・ログ出力はここでは行わない（純粋関数のみでテスト可能にする）。
 */

/** カンマ区切り文字列を trim・空要素除去・重複除去した配列に変換する。 */
export function parseAllowedUserIds(raw: string | undefined): string[] {
  if (!raw) {
    return [];
  }
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return Array.from(new Set(ids));
}

/** userId が許可リストに含まれるかどうか。allowed が空なら常に false（全拒否）。 */
export function isUserAllowed(allowed: string[], userId: string): boolean {
  if (allowed.length === 0) {
    return false;
  }
  return allowed.includes(userId);
}
