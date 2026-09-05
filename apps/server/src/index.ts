import 'dotenv/config';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import fastifyStatic from '@fastify/static';
import { healthRoutes } from './routes/health.js';
import { threadRoutes } from './routes/thread.js';
import { messageRoutes } from './routes/message.js';
import { coreRoutes } from './routes/core.js';
import { dispatchRoutes } from './routes/dispatch.js';
import { orchestratorRoutes } from './routes/orchestrator.js';
import { parseWorkerMode, startDispatchWorker } from './orchestrator/dispatch-worker.js';
import type { AttachmentReader } from './orchestrator/dispatch-worker.js';
import type { DispatchQueryClient } from './orchestrator/dispatch-store.js';
import { readManagerSettingsFile } from './orchestrator/manager-settings.js';
import { prisma } from './db/client.js';
import * as coreClient from './core/coreClient.js';
import { requiresAuth } from './auth/route-guard.js';
import { extractBearerToken, createTokenVerifier } from './auth/verify-token.js';
import { createTokenCache } from './auth/cache.js';
import { parseAllowedUserIds, isUserAllowed } from './auth/allow-list.js';

// request.userId は認証成功時にのみセットする（層⑤、サイクル1.27）。
// 本サイクルではユーザー単位のデータ分離はしない（置くだけで既存ルートは参照しない）。
declare module 'fastify' {
  interface FastifyRequest {
    userId?: string;
  }
}

// サイクル1.28: 既定の bodyLimit（1MB）だと base64 添付（合計10MBの生データが base64 で
// 約4/3に膨らみ約13.4MBになる）を積んだ POST /threads/:id/orchestrate が 413 で弾かれる。
// 16MB へ引き上げて安全マージンを確保する（instruction 本文20,000文字分の余白込み）。
const app = Fastify({ logger: true, bodyLimit: 16 * 1024 * 1024 });

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
  // サイクル1.13: 鍵の有無のみをログに出す（値は絶対に出さない）。未設定でも起動は止めない
  // ——orchestrate ルートがリクエスト時に 503「未結線」を返す設計（core/coreClient.ts の
  // DEVRELAY_PAT と同様の扱い）。
  app.log.info(
    `ANTHROPIC_API_KEY=${process.env.ANTHROPIC_API_KEY ? 'set' : 'unset (orchestrate は503を返します)'}`
  );
} catch (err) {
  app.log.error(err);
  app.log.error(
    'manager Settings（config/manager-settings.json）の検証に失敗しました。' +
      'governance テンプレ／tier バインドを修正してください。'
  );
  process.exit(1);
}

// CORS: 空なら @fastify/cors 自体を登録しない（同一オリジン配信が既定の本番構成）。
// 開発時は CORS_ORIGINS=http://localhost:5173 のように指定する。
const corsOrigins = (process.env.CORS_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
if (corsOrigins.length > 0) {
  await app.register(cors, { origin: corsOrigins, credentials: false });
  app.log.info(`CORS_ORIGINS=${corsOrigins.join(',')}`);
} else {
  app.log.warn('CORS_ORIGINS が空のため @fastify/cors は登録しません（同一オリジン配信を想定）。');
}

// 認証（層⑤、サイクル1.27）: core の AuthSession に相乗りする。
// Authorization: Bearer <token> を core の GET /api/auth/me に転送し、得られた userId が
// MANAGER_ALLOWED_USER_IDS に含まれているかで許可判定する。未設定（空）は fail-closed（全拒否）。
const authMode = process.env.MANAGER_AUTH_MODE ?? 'on';
if (authMode !== 'on' && authMode !== 'off') {
  app.log.error(`MANAGER_AUTH_MODE には on/off 以外の値は指定できません: ${authMode}`);
  process.exit(1);
}
if (authMode === 'off') {
  app.log.warn(
    'MANAGER_AUTH_MODE=off: 認証は無効です（ローカル開発専用。本番のインターネット公開では絶対に使わないこと）。'
  );
}
const allowedUserIds = parseAllowedUserIds(process.env.MANAGER_ALLOWED_USER_IDS);
app.log.info(`manager allowed users: ${allowedUserIds.length}`);
if (allowedUserIds.length === 0) {
  app.log.warn('MANAGER_ALLOWED_USER_IDS が空です。認証が有効な間、全ユーザーが 403 になります。');
}
const coreBaseUrl = process.env.CORE_BASE_URL ?? 'https://app.devrelay.io';
const verifyToken = createTokenVerifier({
  coreBaseUrl,
  cache: createTokenCache(60_000),
  fetchImpl: fetch,
  now: () => Date.now(),
});

app.addHook('onRequest', async (request, reply) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (!requiresAuth(request.method, pathname)) {
    return;
  }
  if (authMode === 'off') {
    return;
  }
  const token = extractBearerToken(request.headers.authorization);
  if (!token) {
    return reply.status(401).send({ error: 'unauthorized' });
  }
  const result = await verifyToken(token);
  if (!result.ok) {
    if (result.code === 'upstream_unavailable') {
      return reply.status(503).send({ error: 'auth_upstream_unavailable' });
    }
    return reply.status(401).send({ error: 'unauthorized' });
  }
  if (!isUserAllowed(allowedUserIds, result.userId)) {
    return reply.status(403).send({ error: 'forbidden' });
  }
  request.userId = result.userId;
});

await app.register(healthRoutes);
await app.register(threadRoutes);
await app.register(messageRoutes);
await app.register(coreRoutes);

// dispatch ルート（承認ゲート・手動 tick）。認証層は上の onRequest フックで全ルート共通に
// 掛かっている。worker を使わない既定の 'off' では引き続き登録しない
// （そもそも worker が動かず意味の無いルート群のため）。
if (workerMode !== 'off') {
  await app.register(dispatchRoutes);
  await app.register(orchestratorRoutes);
}

// 静的配信（apps/web/dist）: ビルド成果物が無ければ警告してスキップする。
// SPA は #thread=/#token= のハッシュルーティングのみを使うため、フォールバック配信は不要。
// find-my-way は完全一致の API ルートをワイルドカードより優先して解決するため、
// 登録順に関わらず /threads 等の API パスとは衝突しない。
const webDistDir = fileURLToPath(new URL('../../web/dist', import.meta.url));
if (existsSync(join(webDistDir, 'index.html'))) {
  await app.register(fastifyStatic, { root: webDistDir, prefix: '/' });
  app.log.info(`web dist を静的配信します: ${webDistDir}`);
} else {
  app.log.warn(`web dist が見つかりません（${webDistDir}）。静的配信をスキップします。`);
}

if (workerMode === 'resident') {
  const dispatchClient = prisma.dispatch as unknown as DispatchQueryClient;
  const workerCore = {
    submitInstruction: coreClient.submitInstruction,
    getPlan: coreClient.getPlan,
    approveImplementation: coreClient.approveImplementation,
    getBuildStatus: coreClient.getBuildStatus,
  };
  // サイクル1.28: DispatchAttachment を submit 直前にのみ読む（一覧 API には登場させない）。
  const attachmentReader: AttachmentReader = {
    async listForDispatch(dispatchId) {
      return prisma.dispatchAttachment.findMany({
        where: { dispatchId },
        orderBy: { sortOrder: 'asc' },
        select: { filename: true, mimeType: true, content: true, sortOrder: true },
      });
    },
  };
  startDispatchWorker({
    client: dispatchClient,
    core: workerCore,
    intervalMs: Number(process.env.DISPATCH_WORKER_INTERVAL_MS ?? 30_000),
    log: (message) => app.log.info(message),
    attachments: attachmentReader,
  });
}

// 既定 3100 はローカル開発用。本番は 9026（Caddy の TestFlight 自動生成設定が
// manager.devrelay.io からこのポートへ upstream する。Caddy 側は本サイクルで触らない）。
const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
