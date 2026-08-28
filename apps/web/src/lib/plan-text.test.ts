import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitPlanNoise } from './plan-text.js';

test('15. splitPlanNoise: 🔧/📊 行や Rate Limit/を使用中 を含む行をノイズとして分離する', () => {
  const markdown = [
    '# plan',
    '🔧 Bashを使用中',
    '本文の1行目',
    '📊 Rate Limit 情報',
    '本文の2行目 を使用中ではない普通の文',
  ].join('\n');
  const { body, noise } = splitPlanNoise(markdown);
  assert.equal(noise.length, 3);
  assert.ok(noise.includes('🔧 Bashを使用中'));
  assert.ok(noise.includes('📊 Rate Limit 情報'));
  assert.ok(noise.includes('本文の2行目 を使用中ではない普通の文'));
  assert.equal(body, ['# plan', '本文の1行目'].join('\n'));
});

test('16. splitPlanNoise: ノイズ行が無ければ body は原文と同一で noise は空配列', () => {
  const markdown = '# plan\n本文のみです\n2行目です';
  const { body, noise } = splitPlanNoise(markdown);
  assert.equal(body, markdown);
  assert.deepEqual(noise, []);
});
