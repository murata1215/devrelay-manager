/**
 * orchestrator モデル選択 = tier（サイクル1.11 ③-3）。
 *
 * doc/orchestrator-layer3-design.md §6 D3: セレクタが選ぶのは tier（Heavy/Standard/Light）、
 * tier→model の束ねは manager Settings JSON（manager-settings.ts）が担う。
 * 既定は Standard、per-message で override 可能。
 *
 * 純粋モジュール：import ゼロ（dispatch-state.ts / poll-schedule.ts と同じ方針）。
 * ルーティング規則（intent -> tier）はここが唯一の権威。tier -> model のバインドは
 * このファイルの責務ではない（そちらは manager-settings.ts / Settings JSON）。
 *
 * v2 送り（実装しない。ここに明記する）:
 * - プロジェクト単位の tier ピン留め（特定 repo は常に heavy 等）。
 * - 文脈依存ルーティング（直近の会話量・スレ規模等から動的に tier を変える）。
 */

export const TIERS = ['heavy', 'standard', 'light'] as const;
export type Tier = (typeof TIERS)[number];

/** spec §6「既定：Standard」。 */
export const DEFAULT_TIER: Tier = 'standard';

export const INTENTS = ['plan', 'exec', 'background'] as const;
export type Intent = (typeof INTENTS)[number];

/**
 * v1 のルーティング規則はこの3本だけ（指示スコープ(3)で明示された3規則そのもの）。
 * 表以外の場所にルールを分散させない。
 */
export const ROUTING_RULES: Readonly<Record<Intent, Tier>> = {
  plan: 'standard',
  exec: 'heavy',
  background: 'light',
};

function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

function isIntent(value: unknown): value is Intent {
  return typeof value === 'string' && (INTENTS as readonly string[]).includes(value);
}

/** 未知の tier 文字列をサイレントに既定へ倒さず throw する（no-silent-failure）。 */
export function parseTier(value: unknown): Tier {
  if (!isTier(value)) {
    throw new Error(
      `不明な tier です: ${JSON.stringify(value)}。有効な値は ${TIERS.join(', ')} のいずれかです。`
    );
  }
  return value;
}

/** 未知の intent 文字列をサイレントに扱わず throw する（no-silent-failure）。 */
export function parseIntent(value: unknown): Intent {
  if (!isIntent(value)) {
    throw new Error(
      `不明な intent です: ${JSON.stringify(value)}。有効な値は ${INTENTS.join(', ')} のいずれかです。`
    );
  }
  return value;
}

/**
 * tier を解決する純粋関数（テスト容易性のために I/O を一切含まない）。
 *
 * 優先順位: 明示 override（per-message）> intent のルーティング規則 > DEFAULT_TIER。
 * override / intent どちらも無ければ既定 Standard（spec §6）。
 */
export function resolveTier(intent: Intent | null, override?: Tier | null): Tier {
  if (override != null) {
    return override;
  }
  if (intent != null) {
    return ROUTING_RULES[intent];
  }
  return DEFAULT_TIER;
}
