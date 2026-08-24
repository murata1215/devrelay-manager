/**
 * core への read-only 疎通確認用ルート。
 *
 * 【注意】manager 側の認証（誰がこの API を叩けるか）はまだ実装していない（層⑤で対応予定）。
 * 現時点は localhost / 開発環境での動作確認を前提とする。本番運用前に認証を必ず追加すること。
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
