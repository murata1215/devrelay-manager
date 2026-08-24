import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';

const createMessageSchema = z.object({
  role: z.enum(['user', 'manager']),
  content: z.string().min(1),
});

export async function messageRoutes(app: FastifyInstance) {
  // スレッドへメッセージ追記
  app.post<{ Params: { threadId: string } }>(
    '/threads/:threadId/messages',
    async (request, reply) => {
      const parsed = createMessageSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: parsed.error.flatten() });
      }
      const thread = await prisma.thread.findUnique({
        where: { id: request.params.threadId },
      });
      if (!thread || thread.deletedAt) {
        return reply.status(404).send({ error: 'thread not found' });
      }
      const message = await prisma.message.create({
        data: {
          threadId: request.params.threadId,
          role: parsed.data.role,
          content: parsed.data.content,
        },
      });
      return reply.status(201).send(message);
    }
  );

  // スレッドのメッセージ一覧
  app.get<{ Params: { threadId: string } }>(
    '/threads/:threadId/messages',
    async (request, reply) => {
      const thread = await prisma.thread.findUnique({
        where: { id: request.params.threadId },
      });
      if (!thread || thread.deletedAt) {
        return reply.status(404).send({ error: 'thread not found' });
      }
      const messages = await prisma.message.findMany({
        where: { threadId: request.params.threadId },
        orderBy: { createdAt: 'asc' },
      });
      return messages;
    }
  );
}
