/**
 * Dispatch API（サイクル1.8 ③-2）。
 *
 * 人間ゲート（approve-target / approve-plan / retry-stale / cancel）はここでのみ
 * 状態を進める。worker（dispatch-worker.ts）はこれらの状態（draft / awaiting_approval /
 * stale）を tick の対象にすら含めない。
 *
 * 【注意】manager 側の認証はまだ実装していない（層⑤で対応予定。routes/core.ts と同じ注意）。
 * このためこのルートは DISPATCH_WORKER_MODE !== 'off' のときのみ登録する
 * （index.ts 参照）。本番運用前に認証を必ず追加すること。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import { parseDispatchStatus, isTerminal } from '../orchestrator/dispatch-state.js';
import type { DispatchClient, DispatchQueryClient } from '../orchestrator/dispatch-store.js';
import {
  approveTarget,
  approvePlan,
  retryStale,
  cancelDispatch,
  approveTargetHttpStatus,
} from '../orchestrator/dispatch-gates.js';
import { tick, reconcileOrphans } from '../orchestrator/dispatch-worker.js';
import * as coreClient from '../core/coreClient.js';
import { readManagerSettingsFile } from '../orchestrator/manager-settings.js';
import {
  serializeDispatch,
  listThreadDispatches,
  listThreadDispatchesHttpStatus,
  fetchDispatchPlan,
  fetchDispatchPlanHttpStatus,
} from '../orchestrator/dispatch-view.js';
import type {
  DispatchDetail,
  ThreadReadClient,
  ThreadDispatchListClient,
  DispatchPlanReadClient,
} from '../orchestrator/dispatch-view.js';

/** prisma.dispatch を dispatch-store / dispatch-gates / dispatch-worker が要求する構造的インターフェースへ橋渡しする。 */
const dispatchClient = prisma.dispatch as unknown as DispatchClient & DispatchQueryClient;

/**
 * prisma.thread / prisma.dispatch を dispatch-view.ts が要求する narrow 型へ橋渡しする。
 * dispatchClient（DispatchClient & DispatchQueryClient）との交差型は作らない —
 * findMany のシグネチャが worker 用（take 必須・orderBy 配列）と一覧用（orderBy 単一）で
 * 異なり、交差させるとオーバーロード解決が壊れるため別 const にする。
 */
const threadReadClient = prisma.thread as unknown as ThreadReadClient;
const dispatchListClient = prisma.dispatch as unknown as ThreadDispatchListClient;
const dispatchPlanReadClient = prisma.dispatch as unknown as DispatchPlanReadClient;

const gateCore = {
  listProjects: coreClient.listProjects,
  getPlan: coreClient.getPlan,
};

const workerCore = {
  submitInstruction: coreClient.submitInstruction,
  getPlan: coreClient.getPlan,
  approveImplementation: coreClient.approveImplementation,
  getBuildStatus: coreClient.getBuildStatus,
};

// サイクル1.19 S2: projectId は任意。指定時のみ投げ先を差し替える。
const approveTargetSchema = z.object({
  instruction: z.string().min(1),
  projectId: z.string().min(1).optional(),
});
const cancelSchema = z.object({ reason: z.string().min(1) });
// サイクル1.19 S3: note は任意の自由記述。body 無し/{} は現行どおり許容する。
const approvePlanSchema = z.object({ note: z.string().optional() }).default({});

export async function dispatchRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>('/dispatch/:id', async (request, reply) => {
    const row = await prisma.dispatch.findUnique({ where: { id: request.params.id } });
    if (!row) {
      return reply.status(404).send({ error: 'dispatch not found' });
    }
    return serializeDispatch(row as unknown as DispatchDetail);
  });

  // サイクル1.16 ④-1: スレッドのタイムライン表示用（次サイクル1.17 フロントが使う）。
  app.get<{ Params: { threadId: string } }>(
    '/threads/:threadId/dispatches',
    async (request, reply) => {
      const result = await listThreadDispatches(
        { threads: threadReadClient, dispatches: dispatchListClient },
        request.params.threadId
      );
      if (!result.ok) {
        return reply.status(listThreadDispatchesHttpStatus(result)).send({ error: result.reason });
      }
      return reply.status(200).send({ dispatches: result.dispatches });
    }
  );

  // サイクル1.17 ④-1b: プラン本文は manager DB に持たない（権威は core）。
  // ゲート②承認カード用に都度取り寄せる（読み取り専用・副作用ゼロ）。
  app.get<{ Params: { id: string } }>('/dispatch/:id/plan', async (request, reply) => {
    const result = await fetchDispatchPlan(
      { dispatches: dispatchPlanReadClient, threads: threadReadClient, core: gateCore },
      request.params.id
    );
    if (!result.ok) {
      const body =
        result.code === 'plan_not_ready'
          ? { error: result.reason, status: result.status }
          : { error: result.reason };
      return reply.status(fetchDispatchPlanHttpStatus(result)).send(body);
    }
    return reply.status(200).send(result.plan);
  });

  app.post<{ Params: { id: string } }>('/dispatch/:id/approve-target', async (request, reply) => {
    const parsed = approveTargetSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const row = await prisma.dispatch.findUnique({ where: { id: request.params.id } });
    if (!row) {
      return reply.status(404).send({ error: 'dispatch not found' });
    }
    try {
      const settings = readManagerSettingsFile();
      const result = await approveTarget(
        { client: dispatchClient, core: gateCore, settings },
        {
          id: row.id,
          projectId: row.projectId,
          instruction: parsed.data.instruction,
          newProjectId: parsed.data.projectId,
        }
      );
      if (!result.ok) {
        return reply.status(approveTargetHttpStatus(result)).send({ error: result.reason });
      }
      return reply.status(approveTargetHttpStatus(result)).send({ ok: true, instruction: result.instruction });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(409).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>('/dispatch/:id/approve-plan', async (request, reply) => {
    // body 無し（undefined）でも許容する（.default({}) が受け止める）。
    const parsed = approvePlanSchema.safeParse(request.body ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const row = await prisma.dispatch.findUnique({ where: { id: request.params.id } });
    if (!row) {
      return reply.status(404).send({ error: 'dispatch not found' });
    }
    if (!row.submissionId) {
      return reply.status(409).send({ error: 'この Dispatch には submissionId がありません。' });
    }
    try {
      const result = await approvePlan(
        { client: dispatchClient, core: gateCore },
        { id: row.id, submissionId: row.submissionId, note: parsed.data.note }
      );
      return reply.status(200).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(409).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>('/dispatch/:id/retry-stale', async (request, reply) => {
    const row = await prisma.dispatch.findUnique({ where: { id: request.params.id } });
    if (!row) {
      return reply.status(404).send({ error: 'dispatch not found' });
    }
    if (!row.submissionId) {
      return reply.status(409).send({ error: 'この Dispatch には submissionId がありません。' });
    }
    try {
      const result = await retryStale(
        { client: dispatchClient, core: gateCore },
        { id: row.id, submissionId: row.submissionId }
      );
      return reply.status(200).send(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(409).send({ error: message });
    }
  });

  app.post<{ Params: { id: string } }>('/dispatch/:id/cancel', async (request, reply) => {
    const parsed = cancelSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const row = await prisma.dispatch.findUnique({ where: { id: request.params.id } });
    if (!row) {
      return reply.status(404).send({ error: 'dispatch not found' });
    }
    const status = parseDispatchStatus(row.status);
    if (isTerminal(status)) {
      return reply.status(409).send({ error: `既に終端状態です（status="${status}"）。` });
    }
    try {
      await cancelDispatch(
        { client: dispatchClient, core: gateCore },
        { id: row.id, from: status, reason: parsed.data.reason }
      );
      return reply.status(200).send({ ok: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(409).send({ error: message });
    }
  });

  // DISPATCH_WORKER_MODE=manual 用の単発 tick 実行口。
  app.post('/dispatch/tick', async (_request, reply) => {
    const now = () => new Date();
    const tickReport = await tick({ client: dispatchClient, core: workerCore, now });
    const orphanReport = await reconcileOrphans({ client: dispatchClient, now });
    return reply.status(200).send({ tick: tickReport, reconcileOrphans: orphanReport });
  });
}
