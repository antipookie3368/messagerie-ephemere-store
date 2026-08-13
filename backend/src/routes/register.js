import { redis } from '../redis.js';
import { createSession, isValidPseudo } from '../auth.js';

export default async function registerRoutes(fastify) {
  fastify.post(
    '/api/register',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '10 minutes' },
      },
    },
    async (request, reply) => {
      const { pseudo } = request.body || {};

      if (!isValidPseudo(pseudo)) {
        return reply.code(400).send({
          error: 'invalid_pseudo',
          message: '3 à 24 caractères, lettres/chiffres/-/_ uniquement.',
        });
      }

      const key = `user:${pseudo}`;
      // NX : échoue si le pseudo existe déjà (pas d'écrasement de compte).
      const created = await redis.set(key, JSON.stringify({ createdAt: Date.now() }), 'NX');
      if (!created) {
        return reply.code(409).send({ error: 'pseudo_taken' });
      }

      const sessionToken = await createSession(pseudo);
      return reply.send({ pseudo, sessionToken });
    }
  );
}
