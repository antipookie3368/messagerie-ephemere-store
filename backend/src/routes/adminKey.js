import { redis } from '../redis.js';
import { requireAdmin } from '../adminAuth.js';

const ADMIN_KEY_REDIS_KEY = 'admin:public_key';
const ADMIN_IDENTITY_REDIS_KEY = 'admin:identity_blob';

function isB64(str, maxLen) {
  return typeof str === 'string' && str.length > 0 && str.length <= maxLen;
}

export default async function adminKeyRoutes(fastify) {
  // Public : n'importe quel visiteur doit pouvoir chiffrer un ticket pour
  // l'admin sans handshake préalable.
  fastify.get('/api/admin/public-key', async (request, reply) => {
    const publicKey = await redis.get(ADMIN_KEY_REDIS_KEY);
    if (!publicKey) return reply.code(404).send({ error: 'admin_not_configured' });
    return reply.send({ publicKey });
  });

  // Réservé à l'admin : publie l'identité de chiffrement (clé publique +
  // clé privée chiffrée avec un secret dérivé du mot de passe admin — le
  // serveur ne peut jamais la déchiffrer lui-même).
  fastify.post('/api/admin/public-key', async (request, reply) => {
    const ok = await requireAdmin(request, reply);
    if (!ok) return;

    const { publicKey, encryptedPrivateKey, nonce, salt } = request.body || {};
    if (typeof publicKey !== 'string' || publicKey.length < 32 || publicKey.length > 200) {
      return reply.code(400).send({ error: 'invalid_public_key' });
    }
    if (!isB64(encryptedPrivateKey, 500) || !isB64(nonce, 100) || !isB64(salt, 100)) {
      return reply.code(400).send({ error: 'invalid_identity_blob' });
    }

    await redis.set(ADMIN_KEY_REDIS_KEY, publicKey);
    await redis.set(ADMIN_IDENTITY_REDIS_KEY, JSON.stringify({ publicKey, encryptedPrivateKey, nonce, salt }));
    return reply.send({ ok: true });
  });

  // Réservé à l'admin : récupère le blob chiffré pour reconstruire
  // l'identité sur un nouvel appareil/navigateur (déchiffrement côté client
  // avec le mot de passe, jamais envoyé ni dérivé ici).
  fastify.get('/api/admin/identity', async (request, reply) => {
    const ok = await requireAdmin(request, reply);
    if (!ok) return;

    const raw = await redis.get(ADMIN_IDENTITY_REDIS_KEY);
    if (!raw) return reply.code(404).send({ error: 'identity_not_configured' });
    return reply.send(JSON.parse(raw));
  });
}
