import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTier, resolveTier, ROUTING_RULES, DEFAULT_TIER } from './tier.js';

test('71. parseTier: heavy/standard/light を正しく受理する', () => {
  assert.equal(parseTier('heavy'), 'heavy');
  assert.equal(parseTier('standard'), 'standard');
  assert.equal(parseTier('light'), 'light');
});

test('72. parseTier: 不正値は throw する（no-silent-failure）', () => {
  assert.throws(() => parseTier('extreme'));
  assert.throws(() => parseTier(undefined));
  assert.throws(() => parseTier(123));
});

test('73. resolveTier: plan は standard へルーティングされる', () => {
  assert.equal(resolveTier('plan'), ROUTING_RULES.plan);
  assert.equal(resolveTier('plan'), 'standard');
});

test('74. resolveTier: exec は heavy へルーティングされる', () => {
  assert.equal(resolveTier('exec'), ROUTING_RULES.exec);
  assert.equal(resolveTier('exec'), 'heavy');
});

test('75. resolveTier: background は light へルーティングされる', () => {
  assert.equal(resolveTier('background'), ROUTING_RULES.background);
  assert.equal(resolveTier('background'), 'light');
});

test('76. resolveTier: intent 無し・override 無しは既定 standard', () => {
  assert.equal(resolveTier(null), DEFAULT_TIER);
  assert.equal(resolveTier(null), 'standard');
});

test('77. resolveTier: override が intent 規則より優先される', () => {
  assert.equal(resolveTier('exec', 'light'), 'light');
  assert.equal(resolveTier(null, 'heavy'), 'heavy');
});
