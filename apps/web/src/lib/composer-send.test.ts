import { test } from 'node:test';
import assert from 'node:assert/strict';
import { performSend, canFallbackToMessageOnly, describeSendError } from './composer-send.js';
import type { Attachment } from './attachment.js';

/**
 * `api.ts` の `ApiError` は `import.meta.env` 依存で node のテストから import できないため、
 * 同じ形（`Error` を継承し `status` を持つ）の偽クラスで代用する。
 * `describeSendError` は `instanceof Error` しか見ないので実挙動と等価になる。
 */
class FakeApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function makeAttachment(filename: string): Attachment {
  return {
    id: `att-${filename}`,
    filename,
    mimeType: 'text/plain',
    kind: 'text',
    text: 'hello',
    base64: '',
    byteSize: 5,
  };
}

test('51. performSend: 成功時は content/attachments がクリアされ、send は trim 済み本文と wire 形式の添付を1回だけ受け取る', async () => {
  const calls: Array<{ content: string; attachments: unknown }> = [];
  const state = { content: '  hi  ', attachments: [makeAttachment('a.txt')], error: 'old error' };
  const next = await performSend(state, async (c, a) => {
    calls.push({ content: c, attachments: a });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].content, 'hi');
  assert.deepEqual(calls[0].attachments, [{ filename: 'a.txt', mimeType: 'text/plain', content: 'aGVsbG8=' }]);
  assert.deepEqual(next, { content: '', attachments: [], error: null });
});

test('52. performSend: ネットワークエラーで本文・添付・順序が保持される', async () => {
  const attachments = [makeAttachment('a.txt'), makeAttachment('b.md')];
  const state = { content: '本文です', attachments, error: null };
  const next = await performSend(state, async () => {
    throw new FakeApiError(0, 'manager サーバーに到達できません: fetch failed');
  });
  assert.equal(next.content, '本文です');
  assert.deepEqual(next.attachments, attachments);
  assert.equal(next.attachments[0].filename, 'a.txt');
  assert.equal(next.attachments[1].filename, 'b.md');
  assert.match(next.error ?? '', /manager サーバーに到達できません/);
});

test('53. performSend: manager 側の上限超過（400）で保持される', async () => {
  const attachments = [makeAttachment('a.txt')];
  const state = { content: '本文', attachments, error: null };
  const next = await performSend(state, async () => {
    throw new FakeApiError(400, '本文と添付ファイルの合計文字数が上限（140000文字）を超えています。');
  });
  assert.equal(next.content, '本文');
  assert.deepEqual(next.attachments, attachments);
  assert.match(next.error ?? '', /上限（140000文字）を超えています/);
});

test('54. performSend: core からの検証エラー（502相当）で保持される', async () => {
  const attachments = [makeAttachment('a.txt')];
  const state = { content: '本文', attachments, error: null };
  const next = await performSend(state, async () => {
    throw new FakeApiError(502, 'core への転送に失敗しました');
  });
  assert.equal(next.content, '本文');
  assert.deepEqual(next.attachments, attachments);
  assert.match(next.error ?? '', /core への転送に失敗しました/);
});

test('55. performSend: 失敗直後に同じ state で再送すると成功しクリアされる（そのまま再送信できる）', async () => {
  const attachments = [makeAttachment('a.txt')];
  const state = { content: '本文', attachments, error: null };
  const failed = await performSend(state, async () => {
    throw new FakeApiError(500, 'internal error');
  });
  assert.equal(failed.content, '本文');
  assert.deepEqual(failed.attachments, attachments);

  let called = false;
  const succeeded = await performSend(failed, async () => {
    called = true;
  });
  assert.equal(called, true);
  assert.deepEqual(succeeded, { content: '', attachments: [], error: null });
});

test('56. describeSendError: Error でない値も文字列化して読める形にする', () => {
  const message = describeSendError('boom');
  assert.match(message, /送信に失敗しました: boom/);
  assert.match(message, /本文と添付は保持しています/);
});

test('57. canFallbackToMessageOnly: 404かつ添付0件のときだけ true', () => {
  assert.equal(canFallbackToMessageOnly(404, 0), true);
  assert.equal(canFallbackToMessageOnly(404, 1), false);
  assert.equal(canFallbackToMessageOnly(400, 0), false);
  assert.equal(canFallbackToMessageOnly(500, 0), false);
});
