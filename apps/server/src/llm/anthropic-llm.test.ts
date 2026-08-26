import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import type Anthropic_ from '@anthropic-ai/sdk';
import {
  toLlmCompletion,
  createAnthropicLlm,
  anthropicClientFromEnv,
  describeAnthropicError,
} from './anthropic-llm.js';
import type { MessagesCreateClient } from './anthropic-llm.js';

const here = fileURLToPath(import.meta.url);
const selfSourcePath = here.replace(/\.test\.ts$/, '.ts');

/** Anthropic.Message の全フィールドを埋めた fixture（サイクル1.13）。overrides で差し替える。 */
function fakeMessage(overrides: Partial<Anthropic_.Message> = {}): Anthropic_.Message {
  return {
    id: 'msg_test',
    container: null,
    content: [{ type: 'text', text: 'hello', citations: null }],
    model: 'claude-sonnet-5',
    role: 'assistant',
    stop_details: null,
    stop_reason: 'end_turn',
    stop_sequence: null,
    type: 'message',
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 10,
      output_tokens: 20,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
    ...overrides,
  };
}

test('110. toLlmCompletion: 複数 text ブロックを結合し、usage.input_tokens/output_tokens と model を写像する', () => {
  const message = fakeMessage({
    model: 'claude-opus-5',
    content: [
      { type: 'text', text: 'こんにちは、', citations: null },
      { type: 'text', text: '世界。', citations: null },
    ],
    usage: {
      cache_creation: null,
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      inference_geo: null,
      input_tokens: 321,
      output_tokens: 654,
      output_tokens_details: null,
      server_tool_use: null,
      service_tier: null,
    },
  });
  const completion = toLlmCompletion(message);
  assert.equal(completion.text, 'こんにちは、世界。');
  assert.equal(completion.model, 'claude-opus-5');
  assert.deepEqual(completion.usage, { inputTokens: 321, outputTokens: 654 });
});

test('111. toLlmCompletion: text ブロックが無ければ throw する（空文字を返さない）', () => {
  const message = fakeMessage({ content: [] });
  assert.throws(() => toLlmCompletion(message));
});

test("112. toLlmCompletion: stop_reason が 'max_tokens' なら throw する（切り詰めを invalid に化けさせない）", () => {
  const message = fakeMessage({ stop_reason: 'max_tokens' });
  assert.throws(() => toLlmCompletion(message));
});

test('113. createAnthropicLlm: client.create に渡る model/max_tokens/system/messages がそのまま反映される', async () => {
  let captured: Anthropic_.MessageCreateParamsNonStreaming | undefined;
  const stubClient: MessagesCreateClient = {
    async create(params) {
      captured = params;
      return fakeMessage({ model: params.model });
    },
  };
  const llm = createAnthropicLlm(stubClient, 4096);
  await llm.complete({ model: 'claude-haiku-4-5-20251001', system: 'システム指示', user: 'ユーザー発話' });
  assert.ok(captured);
  assert.equal(captured?.model, 'claude-haiku-4-5-20251001');
  assert.equal(captured?.max_tokens, 4096);
  assert.equal(captured?.system, 'システム指示');
  assert.equal(captured?.messages.length, 1);
  assert.equal(captured?.messages[0].role, 'user');
  assert.equal(captured?.messages[0].content, 'ユーザー発話');
});

test('114. anthropic-llm.ts のソースに claude- で始まるモデル名リテラルが存在しない（ハードコード禁止の機械確認）', () => {
  const source = readFileSync(selfSourcePath, 'utf-8');
  assert.doesNotMatch(source, /claude-[\w-]*/);
});

test('115. describeAnthropicError: 401/429/タイムアウトを別文言に分類し、いずれの文言にも APIキー文字列が含まれない', () => {
  const secretKey = 'sk-ant-super-secret-value-12345';
  const authErr = new Anthropic.AuthenticationError(
    401,
    { type: 'error', error: { type: 'authentication_error', message: secretKey } },
    'unauthorized',
    new Headers()
  );
  const rateLimitErr = new Anthropic.RateLimitError(
    429,
    { type: 'error', error: { type: 'rate_limit_error', message: secretKey } },
    'rate limited',
    new Headers()
  );
  const timeoutErr = new Anthropic.APIConnectionTimeoutError();

  const authMsg = describeAnthropicError(authErr);
  const rateLimitMsg = describeAnthropicError(rateLimitErr);
  const timeoutMsg = describeAnthropicError(timeoutErr);

  assert.notEqual(authMsg, rateLimitMsg);
  assert.notEqual(authMsg, timeoutMsg);
  assert.notEqual(rateLimitMsg, timeoutMsg);
  for (const msg of [authMsg, rateLimitMsg, timeoutMsg]) {
    assert.equal(msg.includes(secretKey), false);
  }
});

test('116. anthropicClientFromEnv: ANTHROPIC_API_KEY 未設定（空文字含む）なら null を返し throw しない', () => {
  const original = process.env.ANTHROPIC_API_KEY;
  try {
    delete process.env.ANTHROPIC_API_KEY;
    assert.equal(anthropicClientFromEnv(60000), null);
    process.env.ANTHROPIC_API_KEY = '';
    assert.equal(anthropicClientFromEnv(60000), null);
    process.env.ANTHROPIC_API_KEY = 'sk-ant-dummy-for-construction-check';
    assert.notEqual(anthropicClientFromEnv(60000), null);
  } finally {
    if (original === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = original;
    }
  }
});
