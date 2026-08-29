/**
 * 決定的 worker（サイクル1.8 ③-2）。
 *
 * LLM を一切使わない。dispatch-state.ts の遷移表が示す nextAction を機械的に
 * 実行して Dispatch を進める。人間ゲート（awaitsHuman な状態）には一切触れない
 * — tick が拾う対象 status は `nextActionFor(s) !== null` から導出するため、
 * draft / awaiting_approval / stale はそもそも取得対象に入らない（構造的に保証）。
 *
 * 遷移表を迂回して status を直接 UPDATE することは禁止。status を書き込む経路は
 * dispatch-store.ts の transitionDispatch / tryTransitionDispatch の2つだけであり、
 * どちらも assertTransition を通る。
 *
 * 二重処理防止（多重起動対策）: 行レベル CAS を唯一の機構にする。claimDispatch で
 * lastPolledAt を CAS してから RPC を打ち、勝ったインスタンスだけが処理する。
 * at-most-once な状態（submitting/approving）は lastPolledAt !== null の行を
 * tick が二度と触らない（＝孤児判定を tick 本体から分離する。理由は
 * reconcileOrphans のコメント参照）。
 */
import {
  DISPATCH_STATUSES,
  nextActionFor,
  parseDispatchStatus,
  awaitsHuman,
} from './dispatch-state.js';
import type { DispatchStatus } from './dispatch-state.js';
import {
  findActionableDispatches,
  claimDispatch,
  tryTransitionDispatch,
  notePollResult,
} from './dispatch-store.js';
import type { DispatchQueryClient, DispatchListRow, DispatchPatch } from './dispatch-store.js';
import { isPollDue, isBudgetExhausted, ORPHAN_GRACE_MINUTES } from './poll-schedule.js';
import { classifyPlanResult, classifyBuildResult } from './core-result.js';

/** worker が拾う対象 status。dispatch-state.ts の表から導出する（ハードコードしない）。 */
const POLLABLE_STATUSES: readonly DispatchStatus[] = DISPATCH_STATUSES.filter(
  (s) => nextActionFor(s) !== null
);

/** at-most-once な nextAction を持つ status。孤児回収の対象。 */
const AT_MOST_ONCE_STATUSES: readonly DispatchStatus[] = DISPATCH_STATUSES.filter(
  (s) => nextActionFor(s)?.retry === 'at-most-once'
);

/** worker が core に対して呼ぶ最小限の RPC 面。core/coreClient.ts の該当関数がこれを満たす。 */
export interface WorkerCoreClient {
  /** サイクル1.21: council は省略可（未指定なら council 無しの従来呼び出しと同形）。 */
  submitInstruction(
    projectId: string,
    instruction: string,
    council?: boolean
  ): Promise<{ submissionId: string }>;
  getPlan(submissionId: string): Promise<unknown>;
  /** サイクル1.19 S3: note は省略可（未指定なら approveNote 無しの従来呼び出しと同形）。 */
  approveImplementation(projectId: string, submissionId: string, note?: string): Promise<unknown>;
  getBuildStatus(submissionId: string): Promise<unknown>;
}

export interface TickDeps {
  client: DispatchQueryClient;
  core: WorkerCoreClient;
  /** クロック注入。Date.now() を直接呼ばない。 */
  now: () => Date;
  limit?: number;
  log?: (message: string) => void;
}

export type TickOutcomeKind = 'transitioned' | 'noted' | 'skipped' | 'error';

export interface TickRowOutcome {
  id: string;
  status: DispatchStatus;
  outcome: TickOutcomeKind;
  detail?: string;
}

export interface TickReport {
  scanned: number;
  claimed: number;
  transitioned: number;
  skipped: number;
  rows: TickRowOutcome[];
  errors: TickRowOutcome[];
}

function emptyReport(): TickReport {
  return { scanned: 0, claimed: 0, transitioned: 0, skipped: 0, rows: [], errors: [] };
}

/**
 * 1回分の tick。対象行を取得し、各行を順番に（並列度1で）処理する。
 * 1行の失敗が他行の処理を止めない（行ごとに try/catch）。
 */
export async function tick(deps: TickDeps): Promise<TickReport> {
  const now = deps.now();
  const limit = deps.limit ?? 20;
  const report = emptyReport();

  const rows = await findActionableDispatches(deps.client, {
    now,
    statuses: POLLABLE_STATUSES,
    limit,
  });
  report.scanned = rows.length;

  for (const row of rows) {
    try {
      const outcome = await processRow(deps, row, now);
      report.rows.push(outcome);
      if (outcome.outcome === 'transitioned') report.transitioned += 1;
      if (outcome.outcome === 'skipped') report.skipped += 1;
      if (outcome.outcome === 'error') report.errors.push(outcome);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const errorOutcome: TickRowOutcome = {
        id: row.id,
        status: parseDispatchStatus(row.status),
        outcome: 'error',
        detail,
      };
      report.rows.push(errorOutcome);
      report.errors.push(errorOutcome);
      deps.log?.(`dispatch tick: id=${row.id} でエラー: ${detail}`);
    }
  }

  return report;
}

async function processRow(deps: TickDeps, row: DispatchListRow, now: Date): Promise<TickRowOutcome> {
  const status = parseDispatchStatus(row.status);
  const action = nextActionFor(status);

  // POLLABLE_STATUSES から取得しているので必ず非 null のはずだが、防御的に確認する。
  if (!action || awaitsHuman(status)) {
    return { id: row.id, status, outcome: 'skipped', detail: '人間ゲートまたは対象外の状態' };
  }

  const lastPolledAt = row.lastPolledAt;
  const statusChangedAt = row.statusChangedAt;

  if (action.retry === 'at-most-once') {
    if (lastPolledAt !== null) {
      // 既に RPC 送信済み（結果不明）。tick はこの行に二度と触らない。
      // 回収は reconcileOrphans に委ねる（理由はモジュール冒頭のコメント参照）。
      return { id: row.id, status, outcome: 'skipped', detail: 'at-most-once 操作が飛行中のためスキップ' };
    }
  } else {
    // idempotent（planning / building）。バジェット枯渇の判定を先に行う。
    if (lastPolledAt !== null && isBudgetExhausted(now, statusChangedAt, status)) {
      const ok = await tryTransitionDispatch(deps.client, {
        id: row.id,
        from: status,
        to: 'stopped',
        reason: `ポーリングバジェットを超過したため停止しました（状態="${status}"）。`,
        at: now,
      });
      return {
        id: row.id,
        status,
        outcome: ok ? 'transitioned' : 'skipped',
        detail: ok ? 'バジェット枯渇により stopped' : '他インスタンスが先に処理済み',
      };
    }
    if (!isPollDue(now, statusChangedAt, lastPolledAt)) {
      return { id: row.id, status, outcome: 'skipped', detail: 'まだポーリング間隔に達していない' };
    }
  }

  const claimed = await claimDispatch(deps.client, { id: row.id, status, now });
  if (!claimed) {
    return { id: row.id, status, outcome: 'skipped', detail: '他インスタンスに claim で先を越された' };
  }

  switch (action.op) {
    case 'submitInstruction':
      return handleSubmitInstruction(deps, row, status, now);
    case 'pollPlan':
      return handlePollPlan(deps, row, status, now);
    case 'approveImplementation':
      return handleApproveImplementation(deps, row, status, now);
    case 'pollBuildStatus':
      return handlePollBuildStatus(deps, row, status, now);
    default:
      return { id: row.id, status, outcome: 'error', detail: `未知の op です: ${String(action.op)}` };
  }
}

async function handleSubmitInstruction(
  deps: TickDeps,
  row: DispatchListRow,
  status: DispatchStatus,
  now: Date
): Promise<TickRowOutcome> {
  if (row.instruction == null) {
    return { id: row.id, status, outcome: 'error', detail: 'instruction が未設定です（不変条件違反）' };
  }
  let result: { submissionId: string };
  try {
    // サイクル1.21: council=true の行だけ第3引数に true を渡す（従来行は undefined で従来同形）。
    result = await deps.core.submitInstruction(row.projectId, row.instruction, row.council ? true : undefined);
  } catch (err) {
    // at-most-once: 結果不明。ここで stopped にはしない（実は成功している可能性がある）。
    // lastPolledAt は claim 済みなので、この行は以後 tick から見えなくなり、
    // reconcileOrphans が猶予後に回収する。
    const detail = err instanceof Error ? err.message : String(err);
    deps.log?.(`dispatch: submitInstruction 呼び出しでエラー（id=${row.id}）: ${detail}`);
    return { id: row.id, status, outcome: 'error', detail };
  }
  const ok = await tryTransitionDispatch(deps.client, {
    id: row.id,
    from: 'submitting',
    to: 'planning',
    patch: { submissionId: result.submissionId },
    at: now,
  });
  return {
    id: row.id,
    status,
    outcome: ok ? 'transitioned' : 'skipped',
    detail: ok ? undefined : '遷移時に他インスタンスへ先を越された（submission 自体は成立済み）',
  };
}

async function handlePollPlan(
  deps: TickDeps,
  row: DispatchListRow,
  status: DispatchStatus,
  now: Date
): Promise<TickRowOutcome> {
  if (row.submissionId == null) {
    return { id: row.id, status, outcome: 'error', detail: 'submissionId が未設定です（不変条件違反）' };
  }
  let raw: unknown;
  try {
    raw = await deps.core.getPlan(row.submissionId);
  } catch (err) {
    // idempotent なので次 tick で再試行される。ここでは記録のみ。
    const detail = err instanceof Error ? err.message : String(err);
    return { id: row.id, status, outcome: 'error', detail };
  }
  const classified = classifyPlanResult(raw);

  if (classified.kind === 'ready') {
    const ok = await tryTransitionDispatch(deps.client, {
      id: row.id,
      from: 'planning',
      to: 'awaiting_approval',
      patch: { submissionId: row.submissionId },
      at: now,
    });
    return { id: row.id, status, outcome: ok ? 'transitioned' : 'skipped' };
  }
  if (classified.kind === 'not_found') {
    const ok = await tryTransitionDispatch(deps.client, {
      id: row.id,
      from: 'planning',
      to: 'failed',
      reason: 'plan 取得で submission が見つかりませんでした（not_found）。',
      at: now,
    });
    return { id: row.id, status, outcome: ok ? 'transitioned' : 'skipped' };
  }
  if (classified.kind === 'error') {
    const ok = await tryTransitionDispatch(deps.client, {
      id: row.id,
      from: 'planning',
      to: 'failed',
      reason: 'plan 取得で core がエラー応答を返しました。',
      at: now,
    });
    return { id: row.id, status, outcome: ok ? 'transitioned' : 'skipped' };
  }
  // pending / unknown: 遷移しない。claim 済みなので lastPolledAt は既に記録されている。
  return { id: row.id, status, outcome: 'noted', detail: `plan 未確定（${classified.kind}）` };
}

async function handleApproveImplementation(
  deps: TickDeps,
  row: DispatchListRow,
  status: DispatchStatus,
  now: Date
): Promise<TickRowOutcome> {
  if (row.submissionId == null) {
    return { id: row.id, status, outcome: 'error', detail: 'submissionId が未設定です（不変条件違反）' };
  }
  try {
    // サイクル1.19 S3: approveNote が null の行は従来どおり第3引数省略（undefined）で呼ぶ。
    await deps.core.approveImplementation(row.projectId, row.submissionId, row.approveNote ?? undefined);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log?.(`dispatch: approveImplementation 呼び出しでエラー（id=${row.id}）: ${detail}`);
    return { id: row.id, status, outcome: 'error', detail };
  }
  const ok = await tryTransitionDispatch(deps.client, {
    id: row.id,
    from: 'approving',
    to: 'building',
    patch: { submissionId: row.submissionId },
    at: now,
  });
  return {
    id: row.id,
    status,
    outcome: ok ? 'transitioned' : 'skipped',
    detail: ok ? undefined : '遷移時に他インスタンスへ先を越された（承認自体は成立済み）',
  };
}

async function handlePollBuildStatus(
  deps: TickDeps,
  row: DispatchListRow,
  status: DispatchStatus,
  now: Date
): Promise<TickRowOutcome> {
  if (row.submissionId == null) {
    return { id: row.id, status, outcome: 'error', detail: 'submissionId が未設定です（不変条件違反）' };
  }
  let raw: unknown;
  try {
    raw = await deps.core.getBuildStatus(row.submissionId);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return { id: row.id, status, outcome: 'error', detail };
  }
  const classified = classifyBuildResult(raw);

  if (classified.kind === 'succeeded') {
    const patch: DispatchPatch = { submissionId: row.submissionId };
    if (classified.buildId) patch.buildId = classified.buildId;
    // サイクル1.19 S5: devlogPath は取れた時だけ patch に含める（core が返さない場合は従来どおり）。
    if (classified.devlogPath) patch.devlogPath = classified.devlogPath;
    const ok = await tryTransitionDispatch(deps.client, {
      id: row.id,
      from: 'building',
      to: 'done',
      patch,
      at: now,
    });
    return { id: row.id, status, outcome: ok ? 'transitioned' : 'skipped' };
  }
  if (classified.kind === 'failed') {
    const patch: DispatchPatch = {};
    if (classified.buildId) patch.buildId = classified.buildId;
    if (classified.devlogPath) patch.devlogPath = classified.devlogPath;
    const ok = await tryTransitionDispatch(deps.client, {
      id: row.id,
      from: 'building',
      to: 'failed',
      reason: classified.summary ?? 'ビルドが失敗しました。',
      patch,
      at: now,
    });
    return { id: row.id, status, outcome: ok ? 'transitioned' : 'skipped' };
  }
  // running / unknown: 遷移しない。
  return { id: row.id, status, outcome: 'noted', detail: `ビルド未完了（${classified.kind}）` };
}

export interface ReconcileOrphansDeps {
  client: DispatchQueryClient;
  now: () => Date;
  graceMinutes?: number;
  limit?: number;
  log?: (message: string) => void;
}

/**
 * at-most-once な状態（submitting/approving）で lastPolledAt が猶予時間より前のまま
 * 更新されていない行を stopped にする。tick 本体から意図的に分離している —
 * tick 内で孤児判定すると、飛行中の RPC が実は成功していた場合に、その結果を
 * 記録するはずだった transitionDispatch が count===0 で失敗し、実在する
 * submission/build の submissionId が永久に失われる（サイクル1.8 ③-2 で発見）。
 * 猶予は MCP SDK の DEFAULT_REQUEST_TIMEOUT_MSEC (60秒) の10倍を既定にしている。
 */
export async function reconcileOrphans(deps: ReconcileOrphansDeps): Promise<TickReport> {
  const now = deps.now();
  const graceMinutes = deps.graceMinutes ?? ORPHAN_GRACE_MINUTES;
  const cutoff = new Date(now.getTime() - graceMinutes * 60_000);
  const limit = deps.limit ?? 50;
  const report = emptyReport();

  const rows = await deps.client.findMany({
    where: {
      status: { in: [...AT_MOST_ONCE_STATUSES] },
      lastPolledAt: { not: null, lt: cutoff },
    },
    orderBy: [{ lastPolledAt: 'asc' }],
    take: limit,
  });
  report.scanned = rows.length;

  for (const row of rows) {
    try {
      const status = parseDispatchStatus(row.status);
      const ok = await tryTransitionDispatch(deps.client, {
        id: row.id,
        from: status,
        to: 'stopped',
        reason: `at-most-once 操作の応答が${graceMinutes}分以上確認できないため停止しました（孤児回収）。`,
        at: now,
      });
      const outcome: TickRowOutcome = {
        id: row.id,
        status,
        outcome: ok ? 'transitioned' : 'skipped',
        detail: ok ? undefined : '他インスタンスが先に処理済み',
      };
      report.rows.push(outcome);
      if (ok) report.transitioned += 1;
      else report.skipped += 1;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const outcome: TickRowOutcome = {
        id: row.id,
        status: parseDispatchStatus(row.status),
        outcome: 'error',
        detail,
      };
      report.rows.push(outcome);
      report.errors.push(outcome);
      deps.log?.(`dispatch reconcileOrphans: id=${row.id} でエラー: ${detail}`);
    }
  }

  return report;
}

export type WorkerMode = 'off' | 'manual' | 'resident';

/**
 * DISPATCH_WORKER_MODE の値を検証する。未知の値はサイレントに 'off' に倒さず throw する
 * （no-silent-failure）。未設定は 'off'（既定オフ。理由は devlog 参照）。
 */
export function parseWorkerMode(raw: string | undefined): WorkerMode {
  const value = raw === undefined || raw.trim() === '' ? 'off' : raw.trim();
  if (value !== 'off' && value !== 'manual' && value !== 'resident') {
    throw new Error(
      `不正な DISPATCH_WORKER_MODE です: "${raw}"。'off' | 'manual' | 'resident' のいずれかを指定してください。`
    );
  }
  return value;
}

export interface StartDispatchWorkerDeps {
  client: DispatchQueryClient;
  core: WorkerCoreClient;
  intervalMs?: number;
  log?: (message: string) => void;
}

export interface DispatchWorkerHandle {
  stop(): void;
}

/**
 * プロセス内常駐ループ。setInterval ではなく setTimeout の再帰で実装する —
 * tick の所要時間が interval を超えても重複起動しない（自己バックプレッシャー）。
 * unref() でこのタイマーだけのためにプロセスが終了できなくなることを防ぐ
 * （テスト・CLI 実行を止めない）。
 */
export function startDispatchWorker(deps: StartDispatchWorkerDeps): DispatchWorkerHandle {
  const intervalMs = deps.intervalMs ?? 30_000;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  async function runOnce(): Promise<void> {
    if (stopped) return;
    try {
      const report = await tick({ client: deps.client, core: deps.core, now: () => new Date(), log: deps.log });
      if (report.transitioned > 0 || report.errors.length > 0) {
        deps.log?.(
          `dispatch tick: scanned=${report.scanned} transitioned=${report.transitioned} errors=${report.errors.length}`
        );
      }
      const orphanReport = await reconcileOrphans({ client: deps.client, now: () => new Date(), log: deps.log });
      if (orphanReport.transitioned > 0) {
        deps.log?.(`dispatch reconcileOrphans: stopped=${orphanReport.transitioned}`);
      }
    } catch (err) {
      deps.log?.(`dispatch worker loop error: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!stopped) {
      timer = setTimeout(() => void runOnce(), intervalMs);
      timer.unref?.();
    }
  }

  timer = setTimeout(() => void runOnce(), 0);
  timer.unref?.();

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
