import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';

import registerRoutes from './routes/register.js';
import roomRoutes from './routes/room.js';
import wsRoutes from './ws/handler.js';
import { startExpiryListener } from './expiry.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND_DIR = process.env.FRONTEND_DIR || path.join(__dirname, '../../frontend/src');
const PORT = Number(process.env.PORT || 3000);

const fastify = Fastify({ logger: true });

// Rate limiting global par défaut ; les routes sensibles fixent leurs
// propres limites plus strictes via `config.rateLimit`.
await fastify.register(fastifyRateLimit, {
  global: true,
  max: 100,
  timeWindow: '1 minute',
});

await fastify.register(fastifyWebsocket);

await fastify.register(fastifyStatic, {
  root: FRONTEND_DIR,
  prefix: '/',
});

await fastify.register(registerRoutes);
await fastify.register(roomRoutes);
await fastify.register(wsRoutes);

fastify.get('/api/health', async () => ({ status: 'ok' }));

await startExpiryListener();

try {
  await fastify.listen({ port: PORT, host: '0.0.0.0' });
} catch (err) {
  fastify.log.error(err);
  process.exit(1);
}
