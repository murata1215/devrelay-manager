/**
 * コスト取得経路（サイクル1.11 ③-3）— インターフェースのみ。ライブ結線はしない。
 *
 * spec §12 未解決項目「コスト取得経路」への決定（本サイクルでは決定と記録のみ）:
 *
 * - core の `get_build_status` 応答にはコスト情報が含まれない（サイクル1.10 devlog で
 *   実測した生 JSON `{phase, buildId, summary, done}` にコストフィールドは無かった）。
 *   よって core build のコストは get_build_status からは取れない。
 * - v1 は経路を2つに分ける:
 *   (a) orchestrator LLM 自身の usage（トークン数等）を manager 側で記録する経路。
 *       LlmPort.complete の戻り値を usage 込みで返すよう拡張すれば足りる（本サイクルでは
 *       戻り値を string に留め、usage 拡張は次サイクル送り）。
 *   (b) core build のコストを core 側の監査ログ（未確定の別 RPC or ログ）から
 *       後追いで取得する経路。ライブ結線は council 実結線（層⑤）と同じタイミングまで
 *       遅延する（council も同様に codex 結線待ちのため、コスト按分の基盤を先に
 *       重複実装しない判断）。
 * - `Dispatch.cost`（既存 Float? 列）は当面未使用のまま。書き込み経路はこのサイクルでは
 *   実装しない。
 *
 * このファイルは型のみを定義する。呼び出し側（実装）は存在しない。
 */

export type CostSourceKind = 'orchestrator-llm' | 'core-build';

export interface DispatchCost {
  source: CostSourceKind;
  inputTokens?: number;
  outputTokens?: number;
  usd?: number;
  capturedAt: Date;
}

/** 将来 (a)/(b) の経路を実装する際に満たすべき最小の取得口。呼び出し側は未実装。 */
export interface CostSource {
  fetchCost(input: { dispatchId: string }): Promise<DispatchCost | null>;
}
