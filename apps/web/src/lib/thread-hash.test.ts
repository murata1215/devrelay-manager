import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseThreadHash, formatThreadHash } from './thread-hash.js';

test('13. formatThreadHash / parseThreadHash の往復', () => {
  const hash = formatThreadHash('abc123');
  assert.equal(hash, '#thread=abc123');
  assert.equal(parseThreadHash(hash), 'abc123');
});

test('14. 不正・空ハッシュは null を返す', () => {
  assert.equal(parseThreadHash(''), null);
  assert.equal(parseThreadHash('#'), null);
  assert.equal(parseThreadHash('#other=1'), null);
  assert.equal(parseThreadHash('#thread='), null);
});
