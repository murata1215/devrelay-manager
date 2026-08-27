import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  serializeDispatch,
  listThreadDispatches,
  listThreadDispatchesHttpStatus,
} from './dispatch-view.js';
import type {
  DispatchDetail,
  ThreadReadClient,
  ThreadDispatchListClient,
  ListThreadDispatchesResult,
} from './dispatch-view.js';

const here = dirname(fileURLToPath(import.meta.url));

/** テスト用の DispatchDetail 全列を持つダミー行を作る（省略したい列だけ overrides で上書き）。 */
function dummyDispatch(overrides: Partial<DispatchDetail> = {}): DispatchDetail {
  return {
    id: 'dispatch-1',
    threadId: 'thread-1',
    messageId: 'message-1',
    projectId: 'project-1',
    instruction: 'do something',
    submissionId: 'submission-1',
    buildId: 'build-1',
    status: 'building',
    statusChangedAt: new Date('2026-08-28T00:00:00.000Z'),
    statusReason: 'reason',
    lastPolledAt: new Date('2026-08-28T00:01:00.000Z'),
    devlogPath: 'doc/devlog/x.md',
    cost: 1.23,
    tier: 'standard',
    model: 'claude-sonnet-5',
    inputTokens: 100,
    outputTokens: 200,
    responseModel: 'claude-sonnet-5-actual',
    createdAt: new Date('2026-08-27T00:00:00.000Z'),
    updatedAt: new Date('2026-08-27T00:00:01.000Z'),
    ...overrides,
  };
}

function stubThreads(row: { id: string; deletedAt: Date | null } | null): {
  client: ThreadReadClient;
  calls: Array<{ where: { id: string } }>;
} {
  const calls: Array<{ where: { id: string } }> = [];
  return {
    calls,
    client: {
      async findUnique(args) {
        calls.push(args);
        return row;
      },
    },
  };
}

function stubDispatches(rows: DispatchDetail[]): {
  client: ThreadDispatchListClient;
  calls: Array<{ where: { threadId: string }; orderBy: { createdAt: 'asc' } }>;
} {
  const calls: Array<{ where: { threadId: string }; orderBy: { createdAt: 'asc' } }> = [];
  return {
    calls,
    client: {
      async findMany(args) {
        calls.push(args);
        return rows;
      },
    },
  };
}

/** #131/#132 用: findMany が呼ばれたら即 throw する（呼び出し 0 回を強制検証する）。 */
function forbiddenDispatchClient(): ThreadDispatchListClient {
  return {
    async findMany() {
      throw new Error('findMany は呼ばれてはならない');
    },
  };
}

test('129. listThreadDispatches: 正常系は3件を createdAt 昇順のまま返し、findMany の引数が正しい', async () => {
  const threads = stubThreads({ id: 'thread-1', deletedAt: null });
  const rows = [
    dummyDispatch({ id: 'd1' }),
    dummyDispatch({ id: 'd2' }),
    dummyDispatch({ id: 'd3' }),
  ];
  const dispatches = stubDispatches(rows);
  const result = await listThreadDispatches(
    { threads: threads.client, dispatches: dispatches.client },
    'thread-1'
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(
      result.dispatches.map((d) => d.id),
      ['d1', 'd2', 'd3']
    );
  }
  assert.deepEqual(dispatches.calls, [{ where: { threadId: 'thread-1' }, orderBy: { createdAt: 'asc' } }]);
});

test('130. listThreadDispatches: 空スレッドは 404 にせず { ok: true, dispatches: [] } を返す', async () => {
  const threads = stubThreads({ id: 'thread-1', deletedAt: null });
  const dispatches = stubDispatches([]);
  const result = await listThreadDispatches(
    { threads: threads.client, dispatches: dispatches.client },
    'thread-1'
  );
  assert.deepEqual(result, { ok: true, dispatches: [] });
});

test('131. listThreadDispatches: 存在しないスレッドは thread_not_found、findMany は呼ばれない', async () => {
  const threads = stubThreads(null);
  const result = await listThreadDispatches(
    { threads: threads.client, dispatches: forbiddenDispatchClient() },
    'thread-missing'
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'thread_not_found');
  }
});

test('132. listThreadDispatches: soft-delete 済みスレッドは thread_not_found、findMany は呼ばれない', async () => {
  const threads = stubThreads({ id: 'thread-1', deletedAt: new Date('2026-08-01T00:00:00.000Z') });
  const result = await listThreadDispatches(
    { threads: threads.client, dispatches: forbiddenDispatchClient() },
    'thread-1'
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'thread_not_found');
  }
});

test('133. serializeDispatch: 全20列の値がそのまま透過する（Date は Date のまま、null は null のまま）', () => {
  const row = dummyDispatch({ messageId: null, statusReason: null, lastPolledAt: null, cost: null, tier: null, model: null, inputTokens: null, outputTokens: null, responseModel: null, instruction: null, submissionId: null, buildId: null, devlogPath: null });
  const result = serializeDispatch(row);
  assert.deepEqual(result, row);
  assert.equal(result.statusChangedAt instanceof Date, true);
  assert.equal(result.createdAt instanceof Date, true);
  assert.equal(result.messageId, null);
});

test('134. serializeDispatch: ホワイトリスト外のプロパティは出力に漏れない', () => {
  const row = dummyDispatch();
  const polluted = { ...row, secretToken: 'do-not-leak' } as DispatchDetail & { secretToken: string };
  const result = serializeDispatch(polluted);
  assert.equal((result as unknown as { secretToken?: string }).secretToken, undefined);
  assert.deepEqual(Object.keys(result).sort(), Object.keys(dummyDispatch()).sort());
});

test('135. スキーマ整合: schema.prisma の model Dispatch のスカラー列と serializeDispatch の出力キーが完全一致する', () => {
  const schemaPath = resolve(here, '../../prisma/schema.prisma');
  const schema = readFileSync(schemaPath, 'utf-8');
  const modelMatch = schema.match(/model Dispatch \{([\s\S]*?)\n\}/);
  assert.ok(modelMatch, 'schema.prisma に model Dispatch が見つかりません');
  const body = modelMatch![1];
  const scalarFields: string[] = [];
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (line.startsWith('///')) continue;
    if (line.startsWith('//')) continue;
    if (line.startsWith('@@')) continue;
    const tokens = line.split(/\s+/);
    const fieldName = tokens[0];
    const fieldType = tokens[1] ?? '';
    // リレーション列（thread: Thread, message: Message?）は除外する。
    if (fieldType.startsWith('Thread') || fieldType.startsWith('Message')) continue;
    scalarFields.push(fieldName);
  }
  const serialized = serializeDispatch(dummyDispatch());
  assert.deepEqual(scalarFields.sort(), Object.keys(serialized).sort());
});

test('136. listThreadDispatchesHttpStatus: ok は 200、thread_not_found は 404', () => {
  const ok: ListThreadDispatchesResult = { ok: true, dispatches: [] };
  const notFound: ListThreadDispatchesResult = { ok: false, code: 'thread_not_found', reason: 'thread not found' };
  assert.equal(listThreadDispatchesHttpStatus(ok), 200);
  assert.equal(listThreadDispatchesHttpStatus(notFound), 404);
});
