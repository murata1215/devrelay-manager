import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health.js';
import { threadRoutes } from './routes/thread.js';
import { messageRoutes } from './routes/message.js';
import { coreRoutes } from './routes/core.js';

const app = Fastify({ logger: true });

await app.register(cors);

await app.register(healthRoutes);
await app.register(threadRoutes);
await app.register(messageRoutes);
await app.register(coreRoutes);

const port = Number(process.env.PORT ?? 3100);
const host = process.env.HOST ?? '0.0.0.0';

try {
  await app.listen({ port, host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
