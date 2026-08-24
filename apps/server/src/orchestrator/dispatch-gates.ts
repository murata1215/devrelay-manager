/**
 * 人間承認ゲート（サイクル1.8 ③-2）。
 *
 * spec §3 の2ゲート（①宛先・内容の事前承認、②core plan の承認）はここでのみ通過する。
 * worker（dispatch-worker.ts）は awaitsHuman な状態（draft / awaiting_approval / stale）
 * を tick の対象にすら含めない（nextActionFor が null のため表から除外される）ので、
 * これらの状態から先へ進む経路はこのモジュールの関数を人間が呼び出す以外に存在しない。
 *
 * 状態遷移は必ず transitionDispatch（dispatch-state.ts の遷移表を通る）経由で行う。
 */
import { transitionDispatch } from './dispatch-store.js';
import type { DispatchClient } from './dispatch-store.js';
import type { DispatchStatus } from './dispatch-state.js';
import { classifyPlanResult } from './core-result.js';

export interface GateCoreClient {
  listProjects(): Promise<Array<{ id: string }>>;
  getPlan(submissionId: string): Promise<unknown>;
}

export interface GateDeps {
  client: DispatchClient;
  core: GateCoreClient;
  /** クロック注入（省略時は transitionDispatch 側の既定 = new Date()）。 */
  now?: () => Date;
}

export interface ApproveTargetInput {
  id: string;
  projectId: string;
  instruction: string;
}

export type ApproveTargetResult = { ok: true } | { ok: false; reason: string };

/**
 * ゲート①: 宛先・内容の事前承認。freshCheck = core の list_projects に projectId が
 * 存在するか。存在しなければ遷移せず理由を返す（spec §8「勝手に諦めない」＝draft に留まる）。
 */
export async function approveTarget(
  deps: GateDeps,
  input: ApproveTargetInput
): Promise<ApproveTargetResult> {
  const projects = await deps.core.listProjects();
  const exists = projects.some((p) => p.id === input.projectId);
  if (!exists) {
    return {
      ok: false,
      reason: `projectId="${input.projectId}" は core の list_projects に見つかりません（freshCheck 失敗）。`,
    };
  }
  await transitionDispatch(deps.client, {
    id: input.id,
    from: 'draft',
    to: 'submitting',
    patch: { instruction: input.instruction },
    at: deps.now?.(),
  });
  return { ok: true };
}

export interface ApprovePlanInput {
  id: string;
  submissionId: string;
}

export type ApprovePlanResult =
  | { outcome: 'approved' }
  | { outcome: 'stale' }
  | { outcome: 'pending'; detail: string }
  | { outcome: 'error'; detail: string };

/**
 * ゲート②: core plan の承認。staleCheck = get_plan(submissionId) が not_found を
 * 返すか。not_found なら stale へ（spec §8: 捨てずに再取得導線を用意する）。
 * plan がまだ確定していなければ遷移せず pending を返す（人間が待つか後で再試行する）。
 */
export async function approvePlan(deps: GateDeps, input: ApprovePlanInput): Promise<ApprovePlanResult> {
  const raw = await deps.core.getPlan(input.submissionId);
  const classified = classifyPlanResult(raw);

  if (classified.kind === 'not_found') {
    await transitionDispatch(deps.client, {
      id: input.id,
      from: 'awaiting_approval',
      to: 'stale',
      reason: 'staleCheck: 承認時に submission が見つかりませんでした（not_found）。',
      patch: { submissionId: input.submissionId },
      at: deps.now?.(),
    });
    return { outcome: 'stale' };
  }
  if (classified.kind === 'ready') {
    await transitionDispatch(deps.client, {
      id: input.id,
      from: 'awaiting_approval',
      to: 'approving',
      patch: { submissionId: input.submissionId },
      at: deps.now?.(),
    });
    return { outcome: 'approved' };
  }
  if (classified.kind === 'error') {
    return { outcome: 'error', detail: 'core が plan 取得でエラー応答を返しました。' };
  }
  return { outcome: 'pending', detail: `plan がまだ確定していません（${classified.kind}）。` };
}

export interface RetryStaleInput {
  id: string;
  submissionId: string;
}

export type RetryStaleResult = { outcome: 'planning' } | { outcome: 'draft' };

/**
 * stale からの再取得導線（spec §8: stale を捨てない）。
 * submission がまだ生きていれば（not_found 以外）planning に戻して worker の
 * ポーリングに再度乗せる。既に存在しない（not_found）なら draft に戻し、
 * ゲート①（宛先・内容の再承認）からやり直す。
 */
export async function retryStale(deps: GateDeps, input: RetryStaleInput): Promise<RetryStaleResult> {
  const raw = await deps.core.getPlan(input.submissionId);
  const classified = classifyPlanResult(raw);

  if (classified.kind === 'not_found') {
    await transitionDispatch(deps.client, {
      id: input.id,
      from: 'stale',
      to: 'draft',
      reason: 'submission が既に存在しないため、宛先選定からやり直します。',
      patch: { submissionId: null },
      at: deps.now?.(),
    });
    return { outcome: 'draft' };
  }

  await transitionDispatch(deps.client, {
    id: input.id,
    from: 'stale',
    to: 'planning',
    patch: { submissionId: input.submissionId },
    at: deps.now?.(),
  });
  return { outcome: 'planning' };
}

export interface CancelDispatchInput {
  id: string;
  from: DispatchStatus;
  reason: string;
}

/** 任意の非終端状態から stopped へ（人間によるキャンセル）。 */
export async function cancelDispatch(deps: GateDeps, input: CancelDispatchInput): Promise<void> {
  await transitionDispatch(deps.client, {
    id: input.id,
    from: input.from,
    to: 'stopped',
    reason: input.reason,
    at: deps.now?.(),
  });
}
