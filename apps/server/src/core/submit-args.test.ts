import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSubmitInstructionArgs } from './submit-args.js';

test('160. buildSubmitInstructionArgs: council 未指定/false なら projectId/instruction の2キーのみ', () => {
  const noArg = buildSubmitInstructionArgs('project-1', '指示本文');
  assert.deepEqual(Object.keys(noArg).sort(), ['instruction', 'projectId']);
  const falseArg = buildSubmitInstructionArgs('project-1', '指示本文', false);
  assert.deepEqual(Object.keys(falseArg).sort(), ['instruction', 'projectId']);
});

test('161. buildSubmitInstructionArgs: council true なら council: true を含む3キー', () => {
  const args = buildSubmitInstructionArgs('project-1', '指示本文', true);
  assert.deepEqual(Object.keys(args).sort(), ['council', 'instruction', 'projectId']);
  assert.equal(args.council, true);
});

test('204. buildSubmitInstructionArgs: attachments 未指定/空配列なら 1.27 以前と同じ2キーのまま（attachments キーが無い）', () => {
  const noArg = buildSubmitInstructionArgs('project-1', '指示本文', undefined, undefined);
  assert.deepEqual(Object.keys(noArg).sort(), ['instruction', 'projectId']);
  const emptyArg = buildSubmitInstructionArgs('project-1', '指示本文', undefined, []);
  assert.deepEqual(Object.keys(emptyArg).sort(), ['instruction', 'projectId']);
});

test('205. buildSubmitInstructionArgs: attachments 指定時は filename/mimeType/content の3キーだけに射影される（sortOrder 等を core へ漏らさない）', () => {
  const args = buildSubmitInstructionArgs('project-1', '指示本文', undefined, [
    { filename: 'a.txt', mimeType: 'text/plain', content: 'aGVsbG8=' } as never,
    // 実際の呼び出し元（dispatch-worker.ts）は sortOrder 等の余計なキーを持つ型を渡し得るため、
    // 余計なキーが混ざっていても3キーだけへ射影されることを確認する。
    { filename: 'b.md', mimeType: 'text/markdown', content: 'aGVsbG8=', sortOrder: 1 } as never,
  ]);
  assert.deepEqual(Object.keys(args).sort(), ['attachments', 'instruction', 'projectId']);
  const attachments = args.attachments as Array<Record<string, unknown>>;
  assert.equal(attachments.length, 2);
  for (const a of attachments) {
    assert.deepEqual(Object.keys(a).sort(), ['content', 'filename', 'mimeType']);
  }
  assert.equal(attachments[0].filename, 'a.txt');
  assert.equal(attachments[1].filename, 'b.md');
});

test('206. buildSubmitInstructionArgs: council と attachments を同時に指定しても両方が独立して反映される', () => {
  const args = buildSubmitInstructionArgs('project-1', '指示本文', true, [
    { filename: 'a.txt', mimeType: 'text/plain', content: 'aGVsbG8=' },
  ]);
  assert.deepEqual(Object.keys(args).sort(), ['attachments', 'council', 'instruction', 'projectId']);
  assert.equal(args.council, true);
});
