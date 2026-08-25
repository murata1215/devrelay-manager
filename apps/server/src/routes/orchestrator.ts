/**
 * orchestrator LLM 層の API（サイクル1.11 ③-3）。
 *
 * このルートは core から候補プロジェクトを取得して orchestrate() へデータとして渡す
 * （orchestrator-llm.ts 自体は coreClient を import しない。境界の詳細は
 * orchestrator-llm.ts のファイル冒頭コメント参照）。
 *
 * このルートは approveTarget / approvePlan を呼ばない。人間ゲート①②は
 * routes/dispatch.ts に残したまま、迂回口を作らない。
 *
 * 【注意】manager 側の認証はまだ実装していない（層⑤で対応予定。routes/dispatch.ts と
 * 同じ注意）。このためこのルートも DISPATCH_WORKER_MODE !== 'off' のときのみ登録する
 * （index.ts 参照）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import * as coreClient from '../core/coreClient.js';
import { orchestrate } from '../orchestrator/orchestrator-llm.js';
import type { LlmPort, OrchestrateDeps } from '../orchestrator/orchestrator-llm.js';
import { prismaDraftSink } from '../orchestrator/draft-sink.js';
import type { DraftCreateClient } from '../orchestrator/draft-sink.js';
import { readManagerSettingsFile } from '../orchestrator/manager-settings.js';
import { parseTier, parseIntent } from '../orchestrator/tier.js';
import type { Tier, Intent } from '../orchestrator/tier.js';

const orchestrateSchema = z.object({
  content: z.string().min(1),
  tier: z.string().optional(),
  intent: z.string().optional(),
});

/**
 * 実 LLM クライアントは本サイクル非スコープ（新規依存が要るため。cycle 1.11 devlog参照）。
 * 未結線であることをサイレントに隠さず、呼ばれたら明示的に throw する（no-silent-failure）。
 */
const unconfiguredLlm: LlmPort = {
  async complete(): Promise<string> {
    throw new Error(
      '実 LLM クライアントが未結線です（サイクル1.11 ③-3 では意図的に非スコープ）。' +
        'LlmPort の実装を index.ts 側で注入してください。'
    );
  },
};

function managerRepoPath(): string {
  return process.env.MANAGER_REPO_PATH ?? process.cwd();
}

export async function orchestratorRoutes(app: FastifyInstance) {
  app.post<{ Params: { threadId: string } }>(
    '/threads/:threadId/orchestrate',
    async (request, reply) => {
      const parsed = orchestrateSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }

      const thread = await prisma.thread.findUnique({ where: { id: request.params.threadId } });
      if (!thread || thread.deletedAt) {
        return reply.status(404).send({ error: 'thread not found' });
      }

      let tierOverride: Tier | null = null;
      let intent: Intent | null = null;
      try {
        if (parsed.data.tier != null) {
          tierOverride = parseTier(parsed.data.tier);
        }
        if (parsed.data.intent != null) {
          intent = parseIntent(parsed.data.intent);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return reply.status(400).send({ error: message });
      }

      const message = await prisma.message.create({
        data: { threadId: request.params.threadId, role: 'user', content: parsed.data.content },
      });

      let settings;
      try {
        settings = readManagerSettingsFile();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({ error: `manager Settings の読み込みに失敗しました: ${detail}` });
      }

      const projects = await coreClient.listProjects();
      const candidates = projects.map((p) => ({
        projectId: p.id,
        name: p.name,
        path: p.path,
        machine: p.machine,
        online: p.online,
      }));

      const deps: OrchestrateDeps = {
        llm: unconfiguredLlm,
        draft: prismaDraftSink(prisma.dispatch as unknown as DraftCreateClient),
        settings,
      };

      try {
        const result = await orchestrate(deps, {
          threadId: request.params.threadId,
          messageId: message.id,
          content: parsed.data.content,
          candidates,
          managerRepoPath: managerRepoPath(),
          intent,
          tierOverride,
        });
        return reply.status(200).send({ messageId: message.id, result });
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({ error: `orchestrate に失敗しました: ${detail}` });
      }
    }
  );
}
