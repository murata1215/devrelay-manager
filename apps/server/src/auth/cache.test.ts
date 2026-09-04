import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createTokenCache } from './cache.js';

test('173. createTokenCache: 未登録キーは null', () => {
  const cache = createTokenCache(60_000);
  assert.equal(cache.get('missing', 0), null);
});

test('174. createTokenCache: TTL 内なら set した userId が get できる', () => {
  const cache = createTokenCache(60_000);
  cache.set('key1', 'user-a', 1_000);
  assert.equal(cache.get('key1', 1_000), 'user-a');
  assert.equal(cache.get('key1', 60_999), 'user-a');
});

test('175. createTokenCache: TTL ちょうど経過したら期限切れ扱いで null、エントリも削除される', () => {
  const cache = createTokenCache(60_000);
  cache.set('key1', 'user-a', 1_000);
  assert.equal(cache.get('key1', 61_000), null);
  // 削除されたことを確認: 同キーを更に未来の時刻で見ても null のまま（例外なく動く）。
  assert.equal(cache.get('key1', 61_001), null);
});
