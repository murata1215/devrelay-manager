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

test('119. prismaDraftSink: usage 3列（inputTokens/outputTokens/responseModel）が create の data に載り、それでも status は載らない（サイクル1.13）', async () => {
  let capturedData: Record<string, unknown> | undefined;
  const stubClient: DraftCreateClient = {
    async create(args) {
      capturedData = args.data as unknown as Record<string, unknown>;
      return { id: 'dispatch-usage-1' };
    },
  };
  const sink = prismaDraftSink(stubClient);
  await sink.createDraft({
    threadId: 't1',
    projectId: 'p1',
    instruction: '本文',
    tier: 'standard',
    model: 'claude-sonnet-5',
    inputTokens: 100,
    outputTokens: 200,
    responseModel: 'claude-sonnet-5',
  });
  assert.ok(capturedData);
  assert.equal(capturedData?.inputTokens, 100);
  assert.equal(capturedData?.outputTokens, 200);
  assert.equal(capturedData?.responseModel, 'claude-sonnet-5');
  assert.equal('status' in (capturedData as object), false);
});

test('162. prismaDraftSink: council 未指定なら create の data に council キーが含まれない（サイクル1.21 以前と同形）', async () => {
  let capturedData: Record<string, unknown> | undefined;
  const stubClient: DraftCreateClient = {
    async create(args) {
      capturedData = args.data as unknown as Record<string, unknown>;
      return { id: 'dispatch-council-off' };
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
  assert.equal('council' in (capturedData as object), false);
});

test('163. prismaDraftSink: council: true を渡すと create の data.council が true になる（サイクル1.21）', async () => {
  let capturedData: Record<string, unknown> | undefined;
  const stubClient: DraftCreateClient = {
    async create(args) {
      capturedData = args.data as unknown as Record<string, unknown>;
      return { id: 'dispatch-council-on' };
    },
  };
  const sink = prismaDraftSink(stubClient);
  await sink.createDraft({
    threadId: 't1',
    projectId: 'p1',
    instruction: '本文',
    tier: 'standard',
    model: 'claude-sonnet-5',
    council: true,
  });
  assert.equal(capturedData?.council, true);
});
