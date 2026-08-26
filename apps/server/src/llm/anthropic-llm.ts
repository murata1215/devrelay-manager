/**
 * Anthropic 公式 TypeScript SDK ラッパ（サイクル1.13 実LLM結線）。
 *
 * 【境界】@anthropic-ai/sdk を import するのはこのファイルだけ。
 * orchestrator/orchestrator-llm.ts は LlmPort インターフェースしか知らず、SDK 型を
 * 一切 import しない（依存の向きは anthropic-llm.ts → orchestrator-llm.ts の一方向。
 * LLM 層の推移閉包（orchestrator-llm-structure.test.ts の #99）はエントリファイル群から
 * 外向きに辿るため、このファイルが逆に orchestrator-llm.ts の型を import しても閉包には
 * 入らない＝#99 は無影響。念のため禁止フラグメントに '@anthropic-ai/sdk' を追加してあり、
 * 将来 LLM 層側が直接 SDK を掴もうとしても機械的に検出される）。
 *
 * 【モデル名】このファイルにモデル名を一切書かない。complete() に渡された model 引数
 * （呼び出し側が tierModels から解決した結果）をそのまま messages.create に渡す。
 *
 * 独自の fetch ラッパは書かず、SDK のクライアント・型（Anthropic.Message 等）をそのまま
 * 使う。ストリーミングは使わない（非スコープ）。
 */
import Anthropic from '@anthropic-ai/sdk';
import type { LlmPort, LlmCompletion } from '../orchestrator/orchestrator-llm.js';

/**
 * テストで差し替え可能な最小ポート。SDK の型（MessageCreateParamsNonStreaming /
 * Message）をそのまま使い、独自の同等インターフェースを再定義しない。
 */
export interface MessagesCreateClient {
  create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
}

/**
 * Anthropic.Message -> LlmCompletion への純粋変換（I/O を持たないためテストしやすい）。
 *
 * fail-loud:
 * - text ブロックが1つも無ければ throw（空文字列を返して呼び出し側の JSON パースを
 *   「JSON でない」に誤帰属させない）。
 * - stop_reason === 'max_tokens' なら throw（出力が途中で切り詰められている可能性が
 *   あり、それを「スキーマ違反」等の別カテゴリに化けさせない）。
 */
export function toLlmCompletion(message: Anthropic.Message): LlmCompletion {
  const textBlocks = message.content.filter(
    (block): block is Anthropic.TextBlock => block.type === 'text'
  );
  if (textBlocks.length === 0) {
    throw new Error('Anthropic API のレスポンスに text ブロックが含まれていません。');
  }
  if (message.stop_reason === 'max_tokens') {
    throw new Error(
      'Anthropic API のレスポンスが max_tokens で打ち切られました（出力が不完全な可能性があります）。'
    );
  }
  const text = textBlocks.map((block) => block.text).join('');
  return {
    text,
    model: message.model,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
  };
}

/**
 * LlmPort 実装。maxTokens は呼び出し側（manager Settings の llm.maxTokens）から渡す。
 * モデル名はここにもハードコードしない（request.model をそのまま渡すのみ）。
 */
export function createAnthropicLlm(client: MessagesCreateClient, maxTokens: number): LlmPort {
  return {
    async complete(request): Promise<LlmCompletion> {
      const message = await client.create({
        model: request.model,
        max_tokens: maxTokens,
        system: request.system,
        messages: [{ role: 'user', content: request.user }],
      });
      return toLlmCompletion(message);
    },
  };
}

/**
 * ANTHROPIC_API_KEY が未設定（空文字含む）なら null を返す（throw しない＝起動を止めない。
 * routes/orchestrator.ts 側でリクエスト時に 503 として扱う）。
 *
 * timeoutMs はそのまま SDK の timeout に渡し、maxRetries は明示的に 0 にする。
 * 【重要】SDK の maxRetries 既定値は 2 であり、しかもタイムアウトしたリクエストも
 * 既定でリトライされる（公式ドキュメント参照。devlog に参照URL・参照日時を記録）。
 * 「60秒・1回で諦める・自動リトライ無し」という要求を満たすには maxRetries: 0 の
 * 明示が必須。
 */
export function anthropicClientFromEnv(timeoutMs: number): MessagesCreateClient | null {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return null;
  }
  const client = new Anthropic({ apiKey, timeout: timeoutMs, maxRetries: 0 });
  // SDK 本体は messages.create() の形を持つが、MessagesCreateClient は
  // テスト側での差し替えを最小にするため create() を直下に置いた narrow port
  // にしている。ここで実クライアントをその形に薄くラップする（ロジックは持たない）。
  return { create: (params) => client.messages.create(params) };
}

/**
 * APIError を instanceof で分類し日本語メッセージにする（文字列マッチはしない。
 * 公式ドキュメント推奨のとおり typed exception classes を使う）。
 * API キーの値は絶対にメッセージへ含めない（core/coreClient.ts の getPat() と同じ扱い）。
 *
 * 継承関係の都合上、より具体的なクラス（AuthenticationError/RateLimitError/
 * APIConnectionTimeoutError）を APIConnectionError/APIError より先に判定する
 * （APIConnectionTimeoutError は APIConnectionError のサブクラスのため）。
 */
export function describeAnthropicError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) {
    return 'ANTHROPIC_API_KEY が無効です（401 AuthenticationError）。';
  }
  if (err instanceof Anthropic.RateLimitError) {
    return 'Anthropic API のレート制限に達しました（429 RateLimitError）。自動リトライはしません。';
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return 'Anthropic API 呼び出しがタイムアウトしました（自動リトライしない設計のため1回で諦めます）。';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return 'Anthropic API に接続できませんでした。';
  }
  if (err instanceof Anthropic.APIError) {
    return `Anthropic API がエラーを返しました（status=${err.status ?? 'unknown'}）: ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}
