/**
 * manager Settings JSON のロード・検証（サイクル1.11 ③-3）。
 *
 * spec §5 D2: 「テンプレは Settings で管理」。spec §6 D3: 「tier→model の束ねは
 * manager Settings JSON」。この2つを1つの設定ファイル（config/manager-settings.json）
 * に集約し、governance.ts / tier 解決の唯一の設定源とする。
 *
 * 依存は zod のみ（既存依存。新規 npm 依存を追加しない）。fs 読み取りは
 * readManagerSettingsFile に閉じ込め、loadManagerSettings 自体は純粋関数
 * （テストはファイルを経由せずインラインオブジェクトで検証できる）。
 *
 * no-silent-failure: 必須キー欠落・空文字・requiredClauses がテンプレ本文に
 * 含まれない、のいずれも既定値へのフォールバックをせず throw する。
 * LLM 層・人間のどちらであっても governance テンプレを「うっかり省略する」ことを
 * 起動時に検出できるようにするための唯一の関所。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { TIERS } from './tier.js';
import type { Tier } from './tier.js';

/**
 * idForm はサイクル1.12 で追加。モデルIDが「日付付きpinnedスナップショット」か
 * 「日付なし（4.6世代以降）だがそれ自体がpinnedスナップショット」かを区別して記録する。
 * 参照: https://platform.claude.com/docs/en/about-claude/models/overview
 * 「Every Claude model ID is a pinned snapshot, including the dateless IDs used
 * from the 4.6 generation on.」— つまり日付なしだから将来差し替わる別名、というわけではない。
 * note は推測でモデルIDを書いていないことの根拠を人間が読める形で必須記録するためのもの。
 */
const tierModelEntrySchema = z.object({
  model: z.string().min(1, 'tierModels の model は空文字にできません。'),
  label: z.string().min(1, 'tierModels の label は空文字にできません。'),
  idForm: z.enum(['pinned-dated', 'pinned-dateless']),
  note: z.string().min(1, 'tierModels の note は空文字にできません（出所の記録を必須にする）。'),
});

const managerSettingsSchema = z.object({
  version: z.number(),
  defaultTier: z.enum(TIERS),
  tierModels: z.object({
    heavy: tierModelEntrySchema,
    standard: tierModelEntrySchema,
    light: tierModelEntrySchema,
  }),
  /** モデルID一次情報の出所。推測で埋めていないことを構造として残す（サイクル1.12）。 */
  modelIdSource: z.object({
    url: z.string().min(1),
    checkedAt: z.string().min(1),
  }),
  /**
   * サイクル1.13 実LLM結線: Anthropic API 呼び出しの実行パラメータ。マジックナンバーに
   * せず、1.12 の起動時検証（index.ts）がそのまま効くよう Settings に持たせる。
   * timeoutMs: 60000 は「60秒でタイムアウトし1回で諦める」という要求値そのもの
   * （llm/anthropic-llm.ts の anthropicClientFromEnv で maxRetries:0 と組み合わせて使う）。
   */
  llm: z.object({
    timeoutMs: z.number().int().positive('llm.timeoutMs は正の整数にしてください。'),
    maxTokens: z.number().int().positive('llm.maxTokens は正の整数にしてください。'),
  }),
  governance: z.object({
    requiredClauses: z.array(z.string().min(1)).min(1),
    header: z.string(),
    footer: z.string(),
  }),
});

export type ManagerSettings = z.infer<typeof managerSettingsSchema>;

/**
 * requiredClauses の各文字列が header+footer に実在するかを検証する。
 * loadManagerSettings 内部でも呼ぶが、governance.ts からも独立して再検証できるよう export する
 * （draft 作成直前の二重の関所として使う。設計参照: doc/orchestrator-layer3-design.md §5）。
 */
export function assertRequiredClausesPresent(settings: Pick<ManagerSettings, 'governance'>): void {
  const combined = settings.governance.header + settings.governance.footer;
  const missing = settings.governance.requiredClauses.filter((clause) => !combined.includes(clause));
  if (missing.length > 0) {
    throw new Error(
      `governance テンプレに必須の文言が含まれていません: [${missing.join(', ')}]。` +
        `header/footer を変更した場合は、これらの文言が両者を連結した文字列に含まれるようにしてください。`
    );
  }
}

/**
 * 生の値（JSON.parse 済みの unknown）を検証し ManagerSettings にする。
 * 純粋関数：ファイル・環境変数に一切触れない。
 */
export function loadManagerSettings(raw: unknown): ManagerSettings {
  const parsed = managerSettingsSchema.parse(raw);
  assertRequiredClausesPresent(parsed);
  return parsed;
}

/** tier -> model 文字列を解決する。未バインドの場合は throw する（既定モデルへのフォールバックはしない）。 */
export function resolveModel(tier: Tier, settings: ManagerSettings): string {
  const entry = settings.tierModels[tier];
  if (!entry) {
    throw new Error(`tier="${tier}" に対応する model が Settings JSON にバインドされていません。`);
  }
  return entry.model;
}

let cached: ManagerSettings | null = null;

function defaultSettingsPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // apps/server/src/orchestrator -> apps/server/config/manager-settings.json
  return resolve(here, '..', '..', 'config', 'manager-settings.json');
}

/**
 * ファイルから Settings を読み取り検証する。既定パスは apps/server/config/manager-settings.json。
 * プロセス内で一度読めばキャッシュする（毎リクエスト fs.readFileSync を避けるため）。
 * 読み取り・JSON パース・検証いずれの失敗も fail-loud（呼び出し側で catch してもここでは握り潰さない）。
 */
export function readManagerSettingsFile(path?: string): ManagerSettings {
  if (cached && !path) {
    return cached;
  }
  const target = path ?? defaultSettingsPath();
  const text = readFileSync(target, 'utf-8');
  const raw = JSON.parse(text) as unknown;
  const settings = loadManagerSettings(raw);
  if (!path) {
    cached = settings;
  }
  return settings;
}

/** テスト専用: モジュールキャッシュをリセットする。 */
export function resetManagerSettingsCacheForTest(): void {
  cached = null;
}
