import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../db/client.js';

const createThreadSchema = z.object({
  title: z.string().min(1),
  ownerId: z.string().min(1),
});

export async function threadRoutes(app: FastifyInstance) {
  // スレッド作成
  app.post('/threads', async (request, reply) => {
    const parsed = createThreadSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.flatten() });
    }
    const thread = await prisma.thread.create({
      data: {
        title: parsed.data.title,
        ownerId: parsed.data.ownerId,
      },
    });
    return reply.status(201).send(thread);
  });

  // スレッド一覧（論理削除されていないもののみ）
  app.get('/threads', async () => {
    const threads = await prisma.thread.findMany({
      where: { deletedAt: null },
      orderBy: { createdAt: 'desc' },
    });
    return threads;
  });

  // スレッド取得
  app.get<{ Params: { id: string } }>('/threads/:id', async (request, reply) => {
    const thread = await prisma.thread.findUnique({
      where: { id: request.params.id },
    });
    if (!thread || thread.deletedAt) {
      return reply.status(404).send({ error: 'thread not found' });
    }
    return thread;
  });
}
