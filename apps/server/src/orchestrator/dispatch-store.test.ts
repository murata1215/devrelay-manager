import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  transitionDispatch,
  tryTransitionDispatch,
  claimDispatch,
  notePollResult,
} from './dispatch-store.js';
import type { DispatchClient, DispatchQueryClient, DispatchListRow } from './dispatch-store.js';

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

test('42. transitionDispatch: at を渡すと statusChangedAt に注入した時刻が使われる', async () => {
  const { client, calls } = createStubClient();
  const at = new Date('2026-08-25T00:00:00Z');
  await transitionDispatch(client, {
    id: 'd1',
    from: 'draft',
    to: 'submitting',
    patch: { instruction: 'x' },
    at,
  });
  assert.equal(calls.updateMany[0].data.statusChangedAt, at);
});

test('43. tryTransitionDispatch: 成功時は true を返し DB を1回だけ更新する', async () => {
  const { client, calls } = createStubClient();
  const ok = await tryTransitionDispatch(client, {
    id: 'd1',
    from: 'planning',
    to: 'awaiting_approval',
    patch: { submissionId: 'sub_1' },
  });
  assert.equal(ok, true);
  assert.equal(calls.updateMany.length, 1);
});

test('44. tryTransitionDispatch: count===0（他インスタンスに先を越された）は throw せず false', async () => {
  const { client } = createStubClient({ updateManyCount: 0 });
  const ok = await tryTransitionDispatch(client, {
    id: 'd1',
    from: 'planning',
    to: 'awaiting_approval',
    patch: { submissionId: 'sub_1' },
  });
  assert.equal(ok, false);
});

test('45. tryTransitionDispatch: 不正遷移・不変条件違反は依然として throw する（DB 呼び出し前）', async () => {
  const { client, calls } = createStubClient();
  await assert.rejects(tryTransitionDispatch(client, { id: 'd1', from: 'done', to: 'building' }));
  assert.equal(calls.updateMany.length, 0);

  const { client: client2, calls: calls2 } = createStubClient();
  await assert.rejects(
    tryTransitionDispatch(client2, { id: 'd1', from: 'submitting', to: 'planning', patch: {} })
  );
  assert.equal(calls2.updateMany.length, 0);
});

test('46. claimDispatch: data は lastPolledAt のみ・成功で true', async () => {
  const { client, calls } = createStubClient();
  const now = new Date('2026-08-25T00:10:00Z');
  const ok = await claimDispatch(client, { id: 'd1', status: 'submitting', now });
  assert.equal(ok, true);
  assert.equal(calls.updateMany.length, 1);
  assert.deepEqual(calls.updateMany[0].where, { id: 'd1', status: 'submitting' });
  assert.deepEqual(calls.updateMany[0].data, { lastPolledAt: now });
});

test('47. claimDispatch: CAS 敗北（count===0）は false を返す（例外にしない）', async () => {
  const { client } = createStubClient({ updateManyCount: 0 });
  const ok = await claimDispatch(client, {
    id: 'd1',
    status: 'submitting',
    now: new Date('2026-08-25T00:10:00Z'),
  });
  assert.equal(ok, false);
});

test('48. notePollResult: status を書かない（updateMany の data に status キーが無い）', async () => {
  const { client, calls } = createStubClient();
  await notePollResult(client, {
    id: 'd1',
    status: 'building',
    patch: { buildId: 'build_123' },
  });
  assert.equal(calls.updateMany.length, 1);
  assert.deepEqual(calls.updateMany[0].where, { id: 'd1', status: 'building' });
  assert.ok(!('status' in calls.updateMany[0].data));
  assert.equal(calls.updateMany[0].data.buildId, 'build_123');
});

test('49. notePollResult: patch が空なら DB を一度も呼び出さない', async () => {
  const { client, calls } = createStubClient();
  await notePollResult(client, { id: 'd1', status: 'planning' });
  assert.equal(calls.updateMany.length, 0);
});

// 型の疎通確認（実行はしない）: DispatchQueryClient が findMany を要求すること。
function _typeCheckOnly(): DispatchQueryClient {
  return {
    async updateMany() {
      return { count: 0 };
    },
    async findUnique() {
      return null;
    },
    async findMany(): Promise<DispatchListRow[]> {
      return [];
    },
  };
}
void _typeCheckOnly;
