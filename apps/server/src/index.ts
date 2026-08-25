import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health.js';
import { threadRoutes } from './routes/thread.js';
import { messageRoutes } from './routes/message.js';
import { coreRoutes } from './routes/core.js';
import { dispatchRoutes } from './routes/dispatch.js';
import { orchestratorRoutes } from './routes/orchestrator.js';
import { parseWorkerMode, startDispatchWorker } from './orchestrator/dispatch-worker.js';
import type { DispatchQueryClient } from './orchestrator/dispatch-store.js';
import { prisma } from './db/client.js';
import * as coreClient from './core/coreClient.js';

const app = Fastify({ logger: true });

// 未知の値をサイレントに 'off' へ倒さず fail-loud にする（no-silent-failure）。
const workerMode = parseWorkerMode(process.env.DISPATCH_WORKER_MODE);
app.log.info(`DISPATCH_WORKER_MODE=${workerMode}`);

await app.register(cors);

await app.register(healthRoutes);
await app.register(threadRoutes);
await app.register(messageRoutes);
await app.register(coreRoutes);

// dispatch ルート（承認ゲート・手動 tick）は manager 側認証が未実装（層⑤）のため、
// worker を使わない既定の 'off' では登録しない（HOST は 0.0.0.0 既定で常時公開されうる）。
if (workerMode !== 'off') {
  await app.register(dispatchRoutes);
  await app.register(orchestratorRoutes);
}

if (workerMode === 'resident') {
  const dispatchClient = prisma.dispatch as unknown as DispatchQueryClient;
  const workerCore = {
    submitInstruction: coreClient.submitInstruction,
    getPlan: coreClient.getPlan,
    approveImplementation: coreClient.approveImplementation,
    getBuildStatus: coreClient.getBuildStatus,
  };
  startDispatchWorker({
    client: dispatchClient,
    core: workerCore,
    intervalMs: Number(process.env.DISPATCH_WORKER_INTERVAL_MS ?? 30_000),
    log: (message) => app.log.info(message),
  });
}

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
