/**
 * conversation-reply.ts の単体テスト（サイクル1.24）。
 * 既存の採番は #1〜#165 が連番で埋まっているため #166 から続ける。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { managerReplyContent, INVALID_REPLY_HEAD } from './conversation-reply.js';
import type { OrchestrateResult } from './orchestrator-llm.js';

test('166. managerReplyContent: conversation は reply 文字列をそのまま返す', () => {
  const result: OrchestrateResult = {
    kind: 'conversation',
    reply: 'こんにちは、ご用件をどうぞ。',
    usage: { inputTokens: 10, outputTokens: 5 },
    responseModel: 'claude-sonnet-5',
  };
  assert.equal(managerReplyContent(result), 'こんにちは、ご用件をどうぞ。');
});

test('167. managerReplyContent: proposal は null（Dispatch 枝では Message を作らない）', () => {
  const result: OrchestrateResult = {
    kind: 'proposal',
    draftId: 'dispatch-1',
    projectId: 'proj-1',
    candidates: [],
    tier: 'standard',
    model: 'claude-sonnet-5',
    instruction: 'do something',
    usage: { inputTokens: 10, outputTokens: 5 },
    responseModel: 'claude-sonnet-5',
  };
  assert.equal(managerReplyContent(result), null);
});

test('168. managerReplyContent: invalid は定型文＋issues を箇条書きで含む', () => {
  const result: OrchestrateResult = {
    kind: 'invalid',
    issues: ['kind: 不明な値です。', 'body: 必須です。'],
  };
  const content = managerReplyContent(result);
  assert.ok(content !== null);
  assert.ok(content.startsWith(INVALID_REPLY_HEAD));
  assert.ok(content.includes('- kind: 不明な値です。'));
  assert.ok(content.includes('- body: 必須です。'));
});

test('169. managerReplyContent: invalid かつ issues が空なら見出しのみ（空の「理由:」を出さない）', () => {
  const result: OrchestrateResult = { kind: 'invalid', issues: [] };
  assert.equal(managerReplyContent(result), INVALID_REPLY_HEAD);
});
