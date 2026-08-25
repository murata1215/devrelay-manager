import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prismaDraftSink } from './draft-sink.js';
import type { DraftCreateClient } from './draft-sink.js';

test('88. prismaDraftSink: create に渡る data に status キーが含まれない', async () => {
  let capturedData: Record<string, unknown> | undefined;
  const stubClient: DraftCreateClient = {
    async create(args) {
      capturedData = args.data as unknown as Record<string, unknown>;
      return { id: 'dispatch-1' };
    },
  };
  const sink = prismaDraftSink(stubClient);
  await sink.createDraft({
    threadId: 't1',
    projectId: 'p1',
    instruction: '本文',
    tier: 'standard',
    model: 'claude-sonnet-5',
  });
  assert.ok(capturedData);
  assert.equal('status' in (capturedData as object), false);
  assert.equal('statusChangedAt' in (capturedData as object), false);
  assert.equal('lastPolledAt' in (capturedData as object), false);
});

test('89. prismaDraftSink: create の返り値 id が createDraft の戻り値になる', async () => {
  const stubClient: DraftCreateClient = {
    async create() {
      return { id: 'dispatch-xyz' };
    },
  };
  const sink = prismaDraftSink(stubClient);
  const result = await sink.createDraft({
    threadId: 't1',
    projectId: 'p1',
    instruction: '本文',
    tier: 'heavy',
    model: 'claude-opus-5',
  });
  assert.equal(result.id, 'dispatch-xyz');
});
