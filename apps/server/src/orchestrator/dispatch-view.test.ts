import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  serializeDispatch,
  listThreadDispatches,
  listThreadDispatchesHttpStatus,
  fetchDispatchPlan,
  fetchDispatchPlanHttpStatus,
} from './dispatch-view.js';
import type {
  DispatchDetail,
  ThreadReadClient,
  ThreadDispatchListClient,
  ListThreadDispatchesResult,
  DispatchPlanReadClient,
  PlanCoreClient,
  DispatchPlanResult,
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
    approveNote: 'note-1',
    council: false,
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

/**
 * schema.prisma 全体から `model X { ... }` の宣言名を集める。
 *
 * サイクル1.28: 従来は「型名が Thread/Message で始まるか」という決め打ちでリレーション列を
 * 除外していたが、DispatchAttachment リレーションの追加を機に「型名（? と [] を除去した
 * 裸の型）が schema 内で実際に model 宣言されている名前と一致するか」へ一般化した。
 * これにより新モデルが増えるたびに決め打ち文字列を追記する必要が無くなる一方、
 * 「モデルとして宣言されていない名前」はスカラーとして扱われ続けるため、
 * 見落とし（本来除外すべきリレーションを見逃す）は起きてもスカラー扱いにしかならず、
 * #135 の目的（serializeDispatch の出力とスキーマの完全一致検査）は弱まらない。
 */
function collectModelNames(schema: string): Set<string> {
  const names = new Set<string>();
  const modelDeclRegex = /^model\s+(\w+)\s*\{/gm;
  let m: RegExpExecArray | null;
  while ((m = modelDeclRegex.exec(schema)) !== null) {
    names.add(m[1]);
  }
  return names;
}

/** `Thread` / `Message?` / `DispatchAttachment[]` 等から裸の型名を取り出す。 */
function bareTypeName(fieldType: string): string {
  return fieldType.replace(/\[\]$/, '').replace(/\?$/, '');
}

/** model Dispatch のスカラー列（リレーション以外）を schema.prisma から抽出する。 */
function extractDispatchScalarFields(schema: string, modelNames: Set<string>): string[] {
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
    // リレーション列（thread: Thread, message: Message?, attachments: DispatchAttachment[]）は
    // 「型名が schema 内で model 宣言されている名前と一致する」ことで除外する（決め打ち文字列に依存しない）。
    if (modelNames.has(bareTypeName(fieldType))) continue;
    scalarFields.push(fieldName);
  }
  return scalarFields;
}

test('135. スキーマ整合: schema.prisma の model Dispatch のスカラー列と serializeDispatch の出力キーが完全一致する', () => {
  const schemaPath = resolve(here, '../../prisma/schema.prisma');
  const schema = readFileSync(schemaPath, 'utf-8');
  const modelNames = collectModelNames(schema);
  const scalarFields = extractDispatchScalarFields(schema, modelNames);
  const serialized = serializeDispatch(dummyDispatch());
  assert.deepEqual(scalarFields.sort(), Object.keys(serialized).sort());
});

test('188. #135 の一般化（モデル宣言名による除外）は保護を弱めない: Thread/Message/DispatchAttachment いずれも決め打ち無しで正しく除外され、serializeDispatch の22キーと1つも過不足なく一致する', () => {
  const schemaPath = resolve(here, '../../prisma/schema.prisma');
  const schema = readFileSync(schemaPath, 'utf-8');
  const modelNames = collectModelNames(schema);
  // サイクル1.28 で追加した DispatchAttachment も含め、schema 内の全モデルが集まっていること。
  assert.ok(modelNames.has('Thread'));
  assert.ok(modelNames.has('Message'));
  assert.ok(modelNames.has('Dispatch'));
  assert.ok(modelNames.has('DispatchAttachment'));
  const scalarFields = extractDispatchScalarFields(schema, modelNames);
  // リレーション列（thread/message/attachments）が1つも紛れ込んでいないこと。
  assert.equal(scalarFields.includes('thread'), false);
  assert.equal(scalarFields.includes('message'), false);
  assert.equal(scalarFields.includes('attachments'), false);
  // なりすまし対策: モデル宣言されていない型名（例えば独自の "Tier" 型もどき）は
  // 依然としてスカラー扱いされる（除外規則が広がりすぎて何でも通す退化をしていないこと）。
  assert.equal(bareTypeNameForTest('SomeUndeclaredType?'), 'SomeUndeclaredType');
  assert.equal(modelNames.has('SomeUndeclaredType'), false);
  // 22列（DispatchDetail 全列）と完全一致し続けていること。
  assert.deepEqual(scalarFields.sort(), Object.keys(serializeDispatch(dummyDispatch())).sort());
});

/** 上のなりすまし対策アサーションのためだけの薄いエイリアス（bareTypeName を再利用）。 */
function bareTypeNameForTest(fieldType: string): string {
  return bareTypeName(fieldType);
}

test('136. listThreadDispatchesHttpStatus: ok は 200、thread_not_found は 404', () => {
  const ok: ListThreadDispatchesResult = { ok: true, dispatches: [] };
  const notFound: ListThreadDispatchesResult = { ok: false, code: 'thread_not_found', reason: 'thread not found' };
  assert.equal(listThreadDispatchesHttpStatus(ok), 200);
  assert.equal(listThreadDispatchesHttpStatus(notFound), 404);
});

// ── サイクル1.17 ④-1b: GET /dispatch/:id/plan（fetchDispatchPlan） ──────────

/** テスト用の Dispatch 行（fetchDispatchPlan が読む4列のみ）。 */
function dummyPlanDispatchRow(
  overrides: Partial<{ id: string; threadId: string; submissionId: string | null; status: string }> = {}
): { id: string; threadId: string; submissionId: string | null; status: string } {
  return {
    id: 'dispatch-1',
    threadId: 'thread-1',
    submissionId: 'submission-1',
    status: 'awaiting_approval',
    ...overrides,
  };
}

/**
 * DispatchPlanReadClient のスタブ。findUnique の呼び出しを記録する。
 * update/updateMany/create は「呼ばれたら throw」で持たせ、副作用ゼロを実行でも固定する
 * （DispatchPlanReadClient 型は findUnique しか宣言しないため型としては構造的に不可能だが、
 * ここでは念のため実行時にも固定する）。
 */
function stubPlanDispatch(
  row: { id: string; threadId: string; submissionId: string | null; status: string } | null
): { client: DispatchPlanReadClient; calls: Array<{ where: { id: string } }> } {
  const calls: Array<{ where: { id: string } }> = [];
  const client = {
    async findUnique(args: { where: { id: string } }) {
      calls.push(args);
      return row;
    },
    async update() {
      throw new Error('update は呼ばれてはならない');
    },
    async updateMany() {
      throw new Error('updateMany は呼ばれてはならない');
    },
    async create() {
      throw new Error('create は呼ばれてはならない');
    },
  } as unknown as DispatchPlanReadClient;
  return { client, calls };
}

/** PlanCoreClient のスタブ。getPlan の引数（submissionId）を記録する。 */
function stubPlanCore(impl: (submissionId: string) => Promise<unknown>): {
  core: PlanCoreClient;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    core: {
      async getPlan(submissionId: string) {
        calls.push(submissionId);
        return impl(submissionId);
      },
    },
  };
}

/** #140/#141/#142 用: getPlan が呼ばれたら即 throw する（呼び出し 0 回を強制検証する）。 */
function forbiddenPlanCore(): PlanCoreClient {
  return {
    async getPlan() {
      throw new Error('getPlan は呼ばれてはならない');
    },
  };
}

test('137. fetchDispatchPlan: 正常系（ready）は core の応答をそのまま整形して返す', async () => {
  const dispatches = stubPlanDispatch(dummyPlanDispatchRow());
  const threads = stubThreads({ id: 'thread-1', deletedAt: null });
  const core = stubPlanCore(async () => ({
    status: 'ready',
    planMarkdown: '# plan',
    summary: 'ok',
    executable: true,
  }));
  const result = await fetchDispatchPlan(
    { dispatches: dispatches.client, threads: threads.client, core: core.core },
    'dispatch-1'
  );
  assert.deepEqual(result, {
    ok: true,
    plan: { status: 'ready', planMarkdown: '# plan', summary: 'ok', executable: true },
  });
  assert.deepEqual(core.calls, ['submission-1']);
});

test('138. fetchDispatchPlan: core が planning 中を返せば status: "planning" のまま素通しする', async () => {
  const dispatches = stubPlanDispatch(dummyPlanDispatchRow());
  const threads = stubThreads({ id: 'thread-1', deletedAt: null });
  const core = stubPlanCore(async () => ({ status: 'planning' }));
  const result = await fetchDispatchPlan(
    { dispatches: dispatches.client, threads: threads.client, core: core.core },
    'dispatch-1'
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.plan, { status: 'planning' });
    assert.equal('planMarkdown' in result.plan, false);
  }
});

test('139. fetchDispatchPlan: core の余計なキー・型不正な値は出力に漏れない（ホワイトリスト）', async () => {
  const dispatches = stubPlanDispatch(dummyPlanDispatchRow());
  const threads = stubThreads({ id: 'thread-1', deletedAt: null });
  const core = stubPlanCore(async () => ({
    status: 'ready',
    planMarkdown: 123, // 型不正: string でない
    secretToken: 'do-not-leak',
    executable: 'yes', // 型不正: boolean でない
  }));
  const result = await fetchDispatchPlan(
    { dispatches: dispatches.client, threads: threads.client, core: core.core },
    'dispatch-1'
  );
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.plan, { status: 'ready' });
    assert.equal((result.plan as unknown as { secretToken?: string }).secretToken, undefined);
  }
});

test('140. fetchDispatchPlan: submissionId が null なら plan_not_ready、core は呼ばれない', async () => {
  const dispatches = stubPlanDispatch(dummyPlanDispatchRow({ submissionId: null, status: 'draft' }));
  const threads = stubThreads({ id: 'thread-1', deletedAt: null });
  const result = await fetchDispatchPlan(
    { dispatches: dispatches.client, threads: threads.client, core: forbiddenPlanCore() },
    'dispatch-1'
  );
  assert.deepEqual(result, {
    ok: false,
    code: 'plan_not_ready',
    reason: 'この Dispatch には submissionId がありません。',
    status: 'draft',
  });
});

test('141. fetchDispatchPlan: Dispatch が存在しなければ dispatch_not_found、threads/core は呼ばれない', async () => {
  const dispatches = stubPlanDispatch(null);
  const threads = stubThreads(null);
  const result = await fetchDispatchPlan(
    { dispatches: dispatches.client, threads: threads.client, core: forbiddenPlanCore() },
    'dispatch-missing'
  );
  assert.deepEqual(result, { ok: false, code: 'dispatch_not_found', reason: 'dispatch not found' });
  assert.equal(threads.calls.length, 0);
});

test('142. fetchDispatchPlan: 所属 Thread が soft-delete 済みなら dispatch_not_found、core は呼ばれない', async () => {
  const dispatches = stubPlanDispatch(dummyPlanDispatchRow());
  const threads = stubThreads({ id: 'thread-1', deletedAt: new Date('2026-08-01T00:00:00.000Z') });
  const result = await fetchDispatchPlan(
    { dispatches: dispatches.client, threads: threads.client, core: forbiddenPlanCore() },
    'dispatch-1'
  );
  assert.deepEqual(result, { ok: false, code: 'dispatch_not_found', reason: 'dispatch not found' });
});

test('143. fetchDispatchPlan: core 呼び出しが失敗すれば core_unavailable、Dispatch 状態は変更しない', async () => {
  const dispatches = stubPlanDispatch(dummyPlanDispatchRow());
  const threads = stubThreads({ id: 'thread-1', deletedAt: null });
  const core = stubPlanCore(async () => {
    throw new Error('core MCP へ到達できませんでした。');
  });
  const result = await fetchDispatchPlan(
    { dispatches: dispatches.client, threads: threads.client, core: core.core },
    'dispatch-1'
  );
  assert.deepEqual(result, {
    ok: false,
    code: 'core_unavailable',
    reason: 'core MCP へ到達できませんでした。',
  });
});

test('144. fetchDispatchPlan: core 応答に status が無ければ core_unavailable（成功に倒さない）', async () => {
  const dispatches = stubPlanDispatch(dummyPlanDispatchRow());
  const threads = stubThreads({ id: 'thread-1', deletedAt: null });
  const core = stubPlanCore(async () => ({ foo: 'bar' }));
  const result = await fetchDispatchPlan(
    { dispatches: dispatches.client, threads: threads.client, core: core.core },
    'dispatch-1'
  );
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.code, 'core_unavailable');
  }
});

test('145. fetchDispatchPlan: 全経路で Dispatch の更新系は一切呼ばれない（副作用ゼロ）', async () => {
  // 正常系・404・409・502 いずれの経路でも update/updateMany/create を呼べば
  // スタブが throw するため、例外なく完走すること自体が副作用ゼロの証拠になる。
  const scenarios: Array<() => Promise<DispatchPlanResult>> = [
    async () => {
      const dispatches = stubPlanDispatch(dummyPlanDispatchRow());
      const threads = stubThreads({ id: 'thread-1', deletedAt: null });
      const core = stubPlanCore(async () => ({ status: 'ready', planMarkdown: '# x' }));
      return fetchDispatchPlan({ dispatches: dispatches.client, threads: threads.client, core: core.core }, 'dispatch-1');
    },
    async () => {
      const dispatches = stubPlanDispatch(null);
      const threads = stubThreads(null);
      return fetchDispatchPlan(
        { dispatches: dispatches.client, threads: threads.client, core: forbiddenPlanCore() },
        'dispatch-missing'
      );
    },
    async () => {
      const dispatches = stubPlanDispatch(dummyPlanDispatchRow({ submissionId: null }));
      const threads = stubThreads({ id: 'thread-1', deletedAt: null });
      return fetchDispatchPlan(
        { dispatches: dispatches.client, threads: threads.client, core: forbiddenPlanCore() },
        'dispatch-1'
      );
    },
    async () => {
      const dispatches = stubPlanDispatch(dummyPlanDispatchRow());
      const threads = stubThreads({ id: 'thread-1', deletedAt: null });
      const core = stubPlanCore(async () => {
        throw new Error('接続不可');
      });
      return fetchDispatchPlan({ dispatches: dispatches.client, threads: threads.client, core: core.core }, 'dispatch-1');
    },
  ];
  for (const run of scenarios) {
    await run();
  }
});

test('146. fetchDispatchPlanHttpStatus: ok=200、dispatch_not_found=404、plan_not_ready=409、core_unavailable=502', () => {
  const ok: DispatchPlanResult = { ok: true, plan: { status: 'ready' } };
  const notFound: DispatchPlanResult = { ok: false, code: 'dispatch_not_found', reason: 'dispatch not found' };
  const notReady: DispatchPlanResult = {
    ok: false,
    code: 'plan_not_ready',
    reason: 'この Dispatch には submissionId がありません。',
    status: 'draft',
  };
  const unavailable: DispatchPlanResult = { ok: false, code: 'core_unavailable', reason: 'core error' };
  assert.equal(fetchDispatchPlanHttpStatus(ok), 200);
  assert.equal(fetchDispatchPlanHttpStatus(notFound), 404);
  assert.equal(fetchDispatchPlanHttpStatus(notReady), 409);
  assert.equal(fetchDispatchPlanHttpStatus(unavailable), 502);
});
