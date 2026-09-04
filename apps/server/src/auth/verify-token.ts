/**
 * core AuthSession への相乗り認証（サイクル1.27 認証層）。
 *
 * manager は独自のセッションを持たず、core の `GET /api/auth/me` にトークンをそのまま転送して
 * userId を得る。core が 5xx・応答不能のときはフォールバックせず upstream_unavailable として
 * 扱う（no-silent-failure）。成功結果のみ TokenCache に載せる（cache.ts 参照）。
 */
import { createHash } from 'node:crypto';
import type { TokenCache } from './cache.js';

/** Authorization ヘッダから Bearer トークンを取り出す。無い/空なら null（副作用なし・純粋）。 */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) {
    return null;
  }
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  if (!match) {
    return null;
  }
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

export type VerifyResult =
  | { ok: true; userId: string }
  | { ok: false; code: 'unauthorized' }
  | { ok: false; code: 'upstream_unavailable' };

/** SHA-256 hex。生トークンをキャッシュのキーとしてメモリに残さないため。 */
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

interface CoreMeResponse {
  user: { id: string };
}

function toCoreMeResponse(body: unknown): CoreMeResponse | null {
  if (!isRecord(body) || !isRecord(body.user) || typeof body.user.id !== 'string') {
    return null;
  }
  return { user: { id: body.user.id } };
}

export interface CreateTokenVerifierDeps {
  coreBaseUrl: string;
  cache: TokenCache;
  fetchImpl: typeof fetch;
  now: () => number;
}

/**
 * トークン検証関数を作る（依存を注入する構造化スタイル。テストは fetchImpl をスタブする）。
 * 成功はキャッシュ、失敗（401/403/5xx/接続不能/応答形不正）はキャッシュしない。
 */
export function createTokenVerifier(deps: CreateTokenVerifierDeps): (token: string) => Promise<VerifyResult> {
  return async (token: string): Promise<VerifyResult> => {
    const key = hashToken(token);
    const nowMs = deps.now();
    const cached = deps.cache.get(key, nowMs);
    if (cached !== null) {
      return { ok: true, userId: cached };
    }

    let res: Response;
    try {
      res = await deps.fetchImpl(`${deps.coreBaseUrl}/api/auth/me`, {
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch {
      return { ok: false, code: 'upstream_unavailable' };
    }

    if (res.status === 401 || res.status === 403) {
      return { ok: false, code: 'unauthorized' };
    }
    if (!res.ok) {
      return { ok: false, code: 'upstream_unavailable' };
    }

    let body: unknown;
    try {
      body = await res.json();
    } catch {
      return { ok: false, code: 'upstream_unavailable' };
    }

    const parsed = toCoreMeResponse(body);
    if (!parsed) {
      return { ok: false, code: 'upstream_unavailable' };
    }

    deps.cache.set(key, parsed.user.id, nowMs);
    return { ok: true, userId: parsed.user.id };
  };
}
