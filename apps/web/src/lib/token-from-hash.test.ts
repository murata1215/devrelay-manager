import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTokenFromHash } from './token-from-hash.js';

const VALID_TOKEN = 'a'.repeat(64);

test('30. parseTokenFromHash: #token=<64桁hex> を受理する（大文字hexも可）', () => {
  assert.equal(parseTokenFromHash(`#token=${VALID_TOKEN}`), VALID_TOKEN);
  assert.equal(parseTokenFromHash(`#token=${'A'.repeat(64)}`), 'A'.repeat(64));
});

test('31. parseTokenFromHash: 前置詞が違えば null（#thread= と排他）', () => {
  assert.equal(parseTokenFromHash(`#thread=${VALID_TOKEN}`), null);
  assert.equal(parseTokenFromHash(''), null);
});

test('32. parseTokenFromHash: 桁数不足・16進以外の文字を含む場合は null', () => {
  assert.equal(parseTokenFromHash('#token=' + 'a'.repeat(63)), null);
  assert.equal(parseTokenFromHash('#token=' + 'a'.repeat(65)), null);
  assert.equal(parseTokenFromHash('#token=' + 'z'.repeat(64)), null);
});

test('33. parseTokenFromHash: 空トークンは null', () => {
  assert.equal(parseTokenFromHash('#token='), null);
});
