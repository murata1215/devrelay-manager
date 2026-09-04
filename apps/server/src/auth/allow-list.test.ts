import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAllowedUserIds, isUserAllowed } from './allow-list.js';

test('170. parseAllowedUserIds: 未設定/空文字/空白のみはすべて空配列', () => {
  assert.deepEqual(parseAllowedUserIds(undefined), []);
  assert.deepEqual(parseAllowedUserIds(''), []);
  assert.deepEqual(parseAllowedUserIds('   '), []);
});

test('171. parseAllowedUserIds: カンマ区切りを trim・重複除去する', () => {
  assert.deepEqual(parseAllowedUserIds(' user-a ,user-b,,user-a,user-c '), ['user-a', 'user-b', 'user-c']);
});

test('172. isUserAllowed: 空リストは常に false（全拒否）、一致/不一致は素直に判定する', () => {
  assert.equal(isUserAllowed([], 'user-a'), false);
  assert.equal(isUserAllowed(['user-a', 'user-b'], 'user-a'), true);
  assert.equal(isUserAllowed(['user-a', 'user-b'], 'user-z'), false);
});
