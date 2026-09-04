/**
 * トークン検証結果の短命キャッシュ（サイクル1.27 認証層）。
 *
 * core /api/auth/me への問い合わせは1リクエストごとに毎回発生させると往復コストが大きいため、
 * 検証成功（userId が得られたケース）のみを TTL 付きでキャッシュする。失敗はキャッシュしない
 * （無効化されたトークンがしばらく通り続ける事故を避ける）。
 * 時刻は呼び出し側が注入する（now() をここで呼ばずテスト可能にする）。
 */

export interface TokenCache {
  /** キーに対応する userId。無い/期限切れなら null（期限切れエントリはここで削除する）。 */
  get(key: string, nowMs: number): string | null;
  /** 検証成功時にのみ呼ぶ。 */
  set(key: string, userId: string, nowMs: number): void;
}

interface Entry {
  userId: string;
  expiresAtMs: number;
}

/** Map ベースの TokenCache を作る。ttlMs は set した時刻からの有効期間（ミリ秒）。 */
export function createTokenCache(ttlMs: number): TokenCache {
  const store = new Map<string, Entry>();

  return {
    get(key, nowMs) {
      const entry = store.get(key);
      if (!entry) {
        return null;
      }
      if (nowMs >= entry.expiresAtMs) {
        store.delete(key);
        return null;
      }
      return entry.userId;
    },
    set(key, userId, nowMs) {
      store.set(key, { userId, expiresAtMs: nowMs + ttlMs });
    },
  };
}
