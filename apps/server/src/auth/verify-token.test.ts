import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractBearerToken, createTokenVerifier } from './verify-token.js';
import { createTokenCache } from './cache.js';

test('179. extractBearerToken: "Bearer <token>" / 小文字 bearer を受理し、無し・空トークンは null', () => {
  assert.equal(extractBearerToken('Bearer abc123'), 'abc123');
  assert.equal(extractBearerToken('bearer abc123'), 'abc123');
  assert.equal(extractBearerToken(undefined), null);
  assert.equal(extractBearerToken('Bearer '), null);
  assert.equal(extractBearerToken('Basic xyz'), null);
});

function fakeFetch(handler: (input: string, init?: RequestInit) => Response) {
  let calls = 0;
  const impl = (async (input: string | URL, init?: RequestInit) => {
    calls += 1;
    return handler(String(input), init);
  }) as unknown as typeof fetch;
  return { impl, callCount: () => calls };
}

test('180. createTokenVerifier: core が 200 + {user:{id}} を返せば ok:true でキャッシュされる', async () => {
  const cache = createTokenCache(60_000);
  const { impl, callCount } = fakeFetch(
    () => new Response(JSON.stringify({ user: { id: 'user-a' } }), { status: 200 })
  );
  const verify = createTokenVerifier({ coreBaseUrl: 'https://core.example', cache, fetchImpl: impl, now: () => 0 });
  const result = await verify('tok');
  assert.deepEqual(result, { ok: true, userId: 'user-a' });
  assert.equal(callCount(), 1);
});

test('181. createTokenVerifier: 401 は unauthorized', async () => {
  const cache = createTokenCache(60_000);
  const { impl } = fakeFetch(() => new Response(JSON.stringify({ error: 'Session expired' }), { status: 401 }));
  const verify = createTokenVerifier({ coreBaseUrl: 'https://core.example', cache, fetchImpl: impl, now: () => 0 });
  assert.deepEqual(await verify('tok'), { ok: false, code: 'unauthorized' });
});

test('182. createTokenVerifier: 403 も unauthorized（許可リスト判定と混同しない）', async () => {
  const cache = createTokenCache(60_000);
  const { impl } = fakeFetch(() => new Response('{}', { status: 403 }));
  const verify = createTokenVerifier({ coreBaseUrl: 'https://core.example', cache, fetchImpl: impl, now: () => 0 });
  assert.deepEqual(await verify('tok'), { ok: false, code: 'unauthorized' });
});

test('183. createTokenVerifier: core の 5xx は upstream_unavailable（フォールバックしない）', async () => {
  const cache = createTokenCache(60_000);
  const { impl } = fakeFetch(() => new Response('boom', { status: 503 }));
  const verify = createTokenVerifier({ coreBaseUrl: 'https://core.example', cache, fetchImpl: impl, now: () => 0 });
  assert.deepEqual(await verify('tok'), { ok: false, code: 'upstream_unavailable' });
});

test('184. createTokenVerifier: fetch が例外を投げても upstream_unavailable', async () => {
  const cache = createTokenCache(60_000);
  const impl = (async () => {
    throw new Error('network down');
  }) as unknown as typeof fetch;
  const verify = createTokenVerifier({ coreBaseUrl: 'https://core.example', cache, fetchImpl: impl, now: () => 0 });
  assert.deepEqual(await verify('tok'), { ok: false, code: 'upstream_unavailable' });
});

test('185. createTokenVerifier: 200 だが応答形が不正（user.id 欠落）なら upstream_unavailable', async () => {
  const cache = createTokenCache(60_000);
  const { impl } = fakeFetch(() => new Response(JSON.stringify({ user: {} }), { status: 200 }));
  const verify = createTokenVerifier({ coreBaseUrl: 'https://core.example', cache, fetchImpl: impl, now: () => 0 });
  assert.deepEqual(await verify('tok'), { ok: false, code: 'upstream_unavailable' });
});

test('186. createTokenVerifier: TTL 内の再検証はキャッシュヒットし fetchImpl は1回しか呼ばれない', async () => {
  const cache = createTokenCache(60_000);
  const { impl, callCount } = fakeFetch(
    () => new Response(JSON.stringify({ user: { id: 'user-a' } }), { status: 200 })
  );
  let now = 0;
  const verify = createTokenVerifier({
    coreBaseUrl: 'https://core.example',
    cache,
    fetchImpl: impl,
    now: () => now,
  });
  await verify('same-token');
  now = 30_000;
  await verify('same-token');
  assert.equal(callCount(), 1);
});

test('187. createTokenVerifier: 検証失敗はキャッシュされず、毎回 fetchImpl が呼ばれる', async () => {
  const cache = createTokenCache(60_000);
  const { impl, callCount } = fakeFetch(() => new Response('{}', { status: 401 }));
  const verify = createTokenVerifier({ coreBaseUrl: 'https://core.example', cache, fetchImpl: impl, now: () => 0 });
  await verify('bad-token');
  await verify('bad-token');
  assert.equal(callCount(), 2);
});
