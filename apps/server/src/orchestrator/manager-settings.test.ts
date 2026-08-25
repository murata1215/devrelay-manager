import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadManagerSettings, resolveModel } from './manager-settings.js';
import type { ManagerSettings } from './manager-settings.js';
import type { Tier } from './tier.js';

function validRaw() {
  return {
    version: 1,
    defaultTier: 'standard',
    tierModels: {
      heavy: { model: 'claude-opus-5', label: 'Heavy' },
      standard: { model: 'claude-sonnet-5', label: 'Standard' },
      light: { model: 'claude-haiku-4-5-20251001', label: 'Light' },
    },
    governance: {
      requiredClauses: ['AskUserQuestion禁止', 'devlog', 'STOP'],
      header: '# header AskUserQuestion禁止\n',
      footer: '\n# footer devlog STOP\n',
    },
  };
}

test('78. loadManagerSettings: 正常な設定を検証して受理する', () => {
  const settings = loadManagerSettings(validRaw());
  assert.equal(resolveModel('heavy', settings), 'claude-opus-5');
  assert.equal(resolveModel('standard', settings), 'claude-sonnet-5');
  assert.equal(resolveModel('light', settings), 'claude-haiku-4-5-20251001');
});

test('79. loadManagerSettings: tierModels のいずれかが欠落していると throw する', () => {
  const raw = validRaw();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (raw.tierModels as any).light;
  assert.throws(() => loadManagerSettings(raw));
});

test('80. loadManagerSettings: defaultTier が heavy/standard/light 以外なら throw する', () => {
  const raw = validRaw();
  (raw as unknown as { defaultTier: string }).defaultTier = 'extreme';
  assert.throws(() => loadManagerSettings(raw));
});

test('81. loadManagerSettings: tierModels の model が空文字なら throw する', () => {
  const raw = validRaw();
  raw.tierModels.heavy.model = '';
  assert.throws(() => loadManagerSettings(raw));
});

test('82. loadManagerSettings: requiredClauses の1つをテンプレから抜くと throw する（省略不能の担保）', () => {
  const raw = validRaw();
  // 'STOP' は header にも footer にも含まれているが、両方から消す。
  raw.governance.footer = '\n# footer devlog\n';
  assert.throws(() => loadManagerSettings(raw));
});

test('83. resolveModel: バインドされていない tier を渡すと throw する（既定へフォールバックしない）', () => {
  const settings = loadManagerSettings(validRaw()) as ManagerSettings;
  const broken = { ...settings, tierModels: { ...settings.tierModels } } as ManagerSettings;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  delete (broken.tierModels as any).light;
  assert.throws(() => resolveModel('light' as Tier, broken));
});
