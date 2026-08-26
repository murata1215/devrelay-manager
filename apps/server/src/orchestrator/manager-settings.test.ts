import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { loadManagerSettings, resolveModel, readManagerSettingsFile } from './manager-settings.js';
import type { ManagerSettings } from './manager-settings.js';
import type { Tier } from './tier.js';

const here = dirname(fileURLToPath(import.meta.url));
/** 実際にコミットされている設定ファイル（apps/server/config/manager-settings.json）への明示パス。 */
const COMMITTED_CONFIG_PATH = resolve(here, '..', '..', 'config', 'manager-settings.json');

function validRaw() {
  return {
    version: 1,
    defaultTier: 'standard',
    tierModels: {
      heavy: { model: 'claude-opus-5', label: 'Heavy', idForm: 'pinned-dateless', note: 'test note heavy' },
      standard: { model: 'claude-sonnet-5', label: 'Standard', idForm: 'pinned-dateless', note: 'test note standard' },
      light: { model: 'claude-haiku-4-5-20251001', label: 'Light', idForm: 'pinned-dated', note: 'test note light' },
    },
    modelIdSource: {
      url: 'https://platform.claude.com/docs/en/about-claude/models/overview',
      checkedAt: '2026-08-26',
    },
    llm: { timeoutMs: 60000, maxTokens: 8192 },
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

test('100. readManagerSettingsFile: 実際にコミットされている config を明示パスで読み、起動時検証相当が通る（サイクル1.12 留保2）', () => {
  const settings = readManagerSettingsFile(COMMITTED_CONFIG_PATH);
  assert.equal(resolveModel('heavy', settings), 'claude-opus-5');
  assert.equal(resolveModel('standard', settings), 'claude-sonnet-5');
  assert.equal(resolveModel('light', settings), 'claude-haiku-4-5-20251001');
});

test('101. readManagerSettingsFile: 存在しないパスは throw する（既定へフォールバックしない）', () => {
  assert.throws(() => readManagerSettingsFile(resolve(here, 'no-such-manager-settings.json')));
});

test('109. tierModels: 実 config の各 tier が idForm/note を持ち、modelIdSource が一次情報の出所を記録している（サイクル1.12 留保3）', () => {
  const settings = readManagerSettingsFile(COMMITTED_CONFIG_PATH);
  for (const tier of ['heavy', 'standard', 'light'] as const) {
    const entry = settings.tierModels[tier];
    assert.ok(entry.idForm === 'pinned-dated' || entry.idForm === 'pinned-dateless');
    assert.ok(entry.note.length > 0);
  }
  assert.equal(settings.tierModels.heavy.idForm, 'pinned-dateless');
  assert.equal(settings.tierModels.standard.idForm, 'pinned-dateless');
  assert.equal(settings.tierModels.light.idForm, 'pinned-dated');
  assert.ok(settings.modelIdSource.url.includes('platform.claude.com'));
  assert.ok(settings.modelIdSource.checkedAt.length > 0);
});

test('121. tierModels/llm: 実 config の llm.timeoutMs が60000（60秒・1回で諦める要求値）、llm 欠落は zod が reject する（サイクル1.13）', () => {
  const settings = readManagerSettingsFile(COMMITTED_CONFIG_PATH);
  assert.equal(settings.llm.timeoutMs, 60000);
  assert.ok(settings.llm.maxTokens > 0);

  const raw = validRaw() as Record<string, unknown>;
  delete raw.llm;
  assert.throws(() => loadManagerSettings(raw));
});
