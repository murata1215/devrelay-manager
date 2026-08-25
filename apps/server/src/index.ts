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
import { readManagerSettingsFile } from './orchestrator/manager-settings.js';
import { prisma } from './db/client.js';
import * as coreClient from './core/coreClient.js';

const app = Fastify({ logger: true });

// 未知の値をサイレントに 'off' へ倒さず fail-loud にする（no-silent-failure）。
const workerMode = parseWorkerMode(process.env.DISPATCH_WORKER_MODE);
app.log.info(`DISPATCH_WORKER_MODE=${workerMode}`);

// manager Settings（governance テンプレ・tier→model バインド）は DISPATCH_WORKER_MODE の
// 値に関わらず常に起動時検証する（サイクル1.12 ③-3 留保2）。
// 理由: config/manager-settings.json はリポジトリにコミットされた成果物であり環境依存ではない
// ため、モードで検証有無を分けると「off の開発機では起動できたのに resident の本番で初めて
// 落ちる」という乖離が生まれる。また governance テンプレの欠落は人間ゲートに提示される安全
// 文言の欠落に直結するため、検出は最速・最も一様であるべき（no-silent-failure）。
// リクエスト時（routes/orchestrator.ts）の検証・503応答は多層防御として撤去せず残す。
try {
  const managerSettings = readManagerSettingsFile();
  app.log.info(`manager settings loaded: tiers=${Object.keys(managerSettings.tierModels).join(',')}`);
} catch (err) {
  app.log.error(err);
  app.log.error(
    'manager Settings（config/manager-settings.json）の検証に失敗しました。' +
      'governance テンプレ／tier バインドを修正してください。'
  );
  process.exit(1);
}

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
