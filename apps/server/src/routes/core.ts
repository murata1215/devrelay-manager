/**
 * core への read-only 疎通確認用ルート。
 *
 * 認証（誰がこの API を叩けるか）は index.ts の onRequest フック（層⑤、サイクル1.27）で
 * 全ルート共通に掛かっている。ここには認証ロジックを重複させない。
 */
import type { FastifyInstance } from 'fastify';
import { listProjects } from '../core/coreClient.js';

export async function coreRoutes(app: FastifyInstance) {
  app.get('/core/projects', async (_request, reply) => {
    try {
      const projects = await listProjects();
      return projects;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.status(502).send({ error: message });
    }
  });
}
