import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transitionDispatch } from './dispatch-store.js';
import type { DispatchClient } from './dispatch-store.js';

interface StubCalls {
  updateMany: Array<{ where: { id: string; status: string }; data: Record<string, unknown> }>;
  findUnique: Array<{ where: { id: string } }>;
}

function createStubClient(options: {
  updateManyCount?: number;
  findUniqueResult?: { status: string } | null;
} = {}): { client: DispatchClient; calls: StubCalls } {
  const calls: StubCalls = { updateMany: [], findUnique: [] };
  const client: DispatchClient = {
    async updateMany(args) {
      calls.updateMany.push(args);
      return { count: options.updateManyCount ?? 1 };
    },
    async findUnique(args) {
      calls.findUnique.push(args);
      return options.findUniqueResult ?? null;
    },
  };
  return { client, calls };
}

test('14. 正常系: updateMany が where:{id, status: from} で1回だけ呼ばれる', async () => {
  const { client, calls } = createStubClient();
  await transitionDispatch(client, {
    id: 'd1',
    from: 'draft',
    to: 'submitting',
    patch: { instruction: '対象repoにXを実装して' },
  });
  assert.equal(calls.updateMany.length, 1);
  assert.deepEqual(calls.updateMany[0].where, { id: 'd1', status: 'draft' });
  assert.equal(calls.findUnique.length, 0);
});

test('15. patch フィールドが同一の data オブジェクトに入る（原子性）', async () => {
  const { client, calls } = createStubClient();
  await transitionDispatch(client, {
    id: 'd1',
    from: 'submitting',
    to: 'planning',
    patch: { submissionId: 'sub_123' },
  });
  const { data } = calls.updateMany[0];
  assert.equal(data.status, 'planning');
  assert.equal(data.submissionId, 'sub_123');
  // status と submissionId が同一オブジェクトに同居している（別 UPDATE に分かれていない）
  assert.ok('status' in data && 'submissionId' in data);
});

test('16. reason 未指定なら statusReason: null で上書きされる', async () => {
  const { client, calls } = createStubClient();
  await transitionDispatch(client, {
    id: 'd1',
    from: 'draft',
    to: 'submitting',
    patch: { instruction: 'x' },
  });
  assert.equal(calls.updateMany[0].data.statusReason, null);

  const { client: client2, calls: calls2 } = createStubClient();
  await transitionDispatch(client2, {
    id: 'd2',
    from: 'draft',
    to: 'stopped',
    reason: '人間がキャンセルした',
  });
  assert.equal(calls2.updateMany[0].data.statusReason, '人間がキャンセルした');
});

test('17. 状態変化のたび lastPolledAt: null にリセットされる', async () => {
  const { client, calls } = createStubClient();
  await transitionDispatch(client, {
    id: 'd1',
    from: 'planning',
    to: 'awaiting_approval',
    patch: { submissionId: 'sub_123' },
  });
  assert.equal(calls.updateMany[0].data.lastPolledAt, null);
});

test('18. count===0 かつ行あり -> エラーに実際の現在状態が入る', async () => {
  const { client } = createStubClient({
    updateManyCount: 0,
    findUniqueResult: { status: 'building' },
  });
  await assert.rejects(
    transitionDispatch(client, {
      id: 'd1',
      from: 'planning',
      to: 'awaiting_approval',
      patch: { submissionId: 'sub_123' },
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /building/);
      return true;
    }
  );
});

test('19. count===0 かつ行なし -> not-found の別種エラー', async () => {
  const { client } = createStubClient({ updateManyCount: 0, findUniqueResult: null });
  await assert.rejects(
    transitionDispatch(client, {
      id: 'missing',
      from: 'planning',
      to: 'awaiting_approval',
      patch: { submissionId: 'sub_123' },
    }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /見つかりません/);
      return true;
    }
  );
});

test('20. 不正遷移は DB 呼び出し前に throw する（スタブが一度も呼ばれない）', async () => {
  const { client, calls } = createStubClient();
  await assert.rejects(
    transitionDispatch(client, { id: 'd1', from: 'done', to: 'building' })
  );
  assert.equal(calls.updateMany.length, 0);
  assert.equal(calls.findUnique.length, 0);
});

test('21. 不変条件違反（submitting -> planning に submissionId が無い）は DB 呼び出し前に throw する', async () => {
  const { client, calls } = createStubClient();
  await assert.rejects(
    transitionDispatch(client, { id: 'd1', from: 'submitting', to: 'planning', patch: {} }),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /submissionId/);
      return true;
    }
  );
  assert.equal(calls.updateMany.length, 0);
  assert.equal(calls.findUnique.length, 0);
});

test('22. stale -> draft は submissionId: null を送る', async () => {
  const { client, calls } = createStubClient();
  await transitionDispatch(client, {
    id: 'd1',
    from: 'stale',
    to: 'draft',
    patch: { submissionId: null },
  });
  assert.equal(calls.updateMany[0].data.submissionId, null);
  assert.equal(calls.updateMany[0].data.status, 'draft');
});
