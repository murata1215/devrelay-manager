/**
 * orchestrator LLM 層の API（サイクル1.11 ③-3 → サイクル1.13 で実LLM結線）。
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
 *
 * 【サイクル1.13】ANTHROPIC_API_KEY 未設定時は 503「未結線」を返す（自動フォールバック無し）。
 * SDK を直接扱うのは llm/anthropic-llm.ts のみで、このファイルは MessagesCreateClient /
 * LlmPort という narrow port しか触らない。クライアントは遅延シングルトン
 * （coreClient.ts の getPat() と同じパターン）でプロセス内キャッシュする。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';
import * as coreClient from '../core/coreClient.js';
import { orchestrate } from '../orchestrator/orchestrator-llm.js';
import type { OrchestrateDeps } from '../orchestrator/orchestrator-llm.js';
import { prismaDraftSink } from '../orchestrator/draft-sink.js';
import type { DraftCreateClient } from '../orchestrator/draft-sink.js';
import { readManagerSettingsFile, resolveModel } from '../orchestrator/manager-settings.js';
import type { ManagerSettings } from '../orchestrator/manager-settings.js';
import { parseTier, parseIntent, resolveTier } from '../orchestrator/tier.js';
import type { Tier, Intent } from '../orchestrator/tier.js';
import { managerReplyContent } from '../orchestrator/conversation-reply.js';
import {
  anthropicClientFromEnv,
  createAnthropicLlm,
  describeAnthropicError,
} from '../llm/anthropic-llm.js';
import type { MessagesCreateClient } from '../llm/anthropic-llm.js';
import {
  ALLOWED_ATTACHMENT_MIME_TYPES,
  MAX_ATTACHMENT_COUNT,
  MAX_TOTAL_TEXT_CHARS,
  validateAttachments,
  combinedTextLength,
} from '../orchestrator/attachment.js';

// サイクル1.28: チャット入力へのテキスト添付（フェーズ1）。厳密な内容検証（サイズ・
// MIME・base64・UTF-8）は attachment.ts の validateAttachments が担当するため、ここでは
// 型と件数（core 実測値と同じ上限）のみを zod で弾く。
const attachmentItemSchema = z
  .object({
    filename: z.string().min(1),
    mimeType: z.enum(ALLOWED_ATTACHMENT_MIME_TYPES),
    content: z.string().min(1),
  })
  .strict();

const orchestrateSchema = z.object({
  content: z.string().min(1),
  tier: z.string().optional(),
  intent: z.string().optional(),
  // サイクル1.19 S1: web の project 選択をヒントとして渡す任意フィールド。
  // 候補外の id は無視する（orchestrator-llm.ts 側で処理）。未指定時は挙動不変。
  projectIds: z.array(z.string()).optional(),
  // サイクル1.21: claude↔codex の協議（council）を有効化するオプトイン。未指定/false は
  // 従来と完全同形の挙動を保つ（Dispatch.council は @default(false)）。
  council: z.boolean().optional(),
  // サイクル1.28: 未指定/空配列は 1.27 以前と完全同形の挙動を保つ。
  attachments: z.array(attachmentItemSchema).max(MAX_ATTACHMENT_COUNT).optional(),
});

/**
 * ANTHROPIC_API_KEY はプロセス起動後に変わらない前提で遅延キャッシュする
 * （coreClient.ts のクライアント遅延生成パターンを踏襲）。null は「鍵未設定」を表し、
 * 呼び出しのたびに再チェックしない（都度 process.env を読むと鍵未設定時のホットパスで
 * 無駄な分岐が増えるだけで意味がない。値が実行中に変わる運用は想定しない）。
 */
let cachedClient: MessagesCreateClient | null | undefined;

function anthropicClient(timeoutMs: number): MessagesCreateClient | null {
  if (cachedClient === undefined) {
    cachedClient = anthropicClientFromEnv(timeoutMs);
  }
  return cachedClient;
}

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

      // 副作用（Message 行の作成）の前に、副作用の無い前提チェックを済ませる
      // （サイクル1.13: 従来は message.create の後に検証していたため、503 のたびに
      // 孤児の user Message 行が残っていた。この並べ替えでその問題を解消する）。
      let settings: ManagerSettings;
      try {
        settings = readManagerSettingsFile();
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err);
        return reply.status(503).send({ error: `manager Settings の読み込みに失敗しました: ${detail}` });
      }

      const client = anthropicClient(settings.llm.timeoutMs);
      if (!client) {
        return reply.status(503).send({
          error: 'ANTHROPIC_API_KEY が未設定です（.env に設定してください）。自動フォールバックはしません。',
        });
      }

      // サイクル1.28: 添付検証も副作用（Message 行の作成）より前に済ませる
      // （1.13 と同じ「副作用の前に検証」の踏襲。孤児 Message 行を作らない）。
      const attachmentValidation = validateAttachments(parsed.data.attachments ?? []);
      if (!attachmentValidation.ok) {
        return reply.status(400).send({ error: attachmentValidation.reason, code: attachmentValidation.code });
      }
      const decodedAttachments = attachmentValidation.decoded;
      if (combinedTextLength(parsed.data.content, decodedAttachments) > MAX_TOTAL_TEXT_CHARS) {
        return reply.status(400).send({
          error:
            `本文と添付ファイルの合計文字数が上限（${MAX_TOTAL_TEXT_CHARS}文字）を超えています。` +
            '添付を減らすか本文を短くしてください（要約・切り詰めは行いません）。',
        });
      }

      const message = await prisma.message.create({
        data: { threadId: request.params.threadId, role: 'user', content: parsed.data.content },
      });

      const projects = await coreClient.listProjects();
      const candidates = projects.map((p) => ({
        projectId: p.id,
        name: p.name,
        path: p.path,
        machine: p.machine,
        online: p.online,
      }));

      const deps: OrchestrateDeps = {
        llm: createAnthropicLlm(client, settings.llm.maxTokens),
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
          preferredProjectIds: parsed.data.projectIds,
          council: parsed.data.council,
          attachments: decodedAttachments,
        });

        // サイクル1.24: spec §9 の会話枝は Dispatch を作らないため、返答を Message として
        // 残す（これが無いと web は reload() で何も拾えず、レスポンス body の内容は
        // リロードで消える）。invalid 枝も同様に無言 200 を解消する。proposal 枝は
        // Dispatch カードが表示されるため null（managerReplyContent 側で判定済み）。
        // tier/model は OrchestrateResult に含まれないため、orchestrate() 内部（L175相当）
        // と同一の入力（intent/tierOverride/settings）でルート側が再計算する。
        const replyContent = managerReplyContent(result);
        if (replyContent !== null) {
          const replyTier = resolveTier(intent, tierOverride);
          await prisma.message.create({
            data: {
              threadId: request.params.threadId,
              role: 'manager',
              content: replyContent,
              tier: replyTier,
              model: resolveModel(replyTier, settings),
            },
          });
        }

        return reply.status(200).send({ messageId: message.id, result });
      } catch (err) {
        const detail = describeAnthropicError(err);
        return reply.status(503).send({ error: `orchestrate に失敗しました: ${detail}` });
      }
    }
  );
}
