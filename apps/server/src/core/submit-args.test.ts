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
