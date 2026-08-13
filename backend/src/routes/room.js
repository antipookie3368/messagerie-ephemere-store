import { customAlphabet } from 'nanoid';
import { redis } from '../redis.js';
import { requireAuth } from '../auth.js';
import { broadcastToRoom } from '../ws/registry.js';

const genRoomId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);

const MAX_TIMER_TTL_SECONDS = 60 * 60 * 24; // 24h max pour le mode "délai"
const MIN_TIMER_TTL_SECONDS = 30; // 30s min

function roomKey(roomId) {
  return `room:${roomId}`;
}

export default async function roomRoutes(fastify) {
  // Création d'un salon par le premier participant.
  fastify.post(
    '/api/room',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const pseudo = await requireAuth(request, reply);
      if (!pseudo) return;

      const { publicKey, expireMode, ttlSeconds } = request.body || {};

      if (typeof publicKey !== 'string' || publicKey.length < 32 || publicKey.length > 200) {
        return reply.code(400).send({ error: 'invalid_public_key' });
      }
      if (!['read', 'timer'].includes(expireMode)) {
        return reply.code(400).send({ error: 'invalid_expire_mode' });
      }
      let ttl = null;
      if (expireMode === 'timer') {
        ttl = Number(ttlSeconds);
        if (!Number.isInteger(ttl) || ttl < MIN_TIMER_TTL_SECONDS || ttl > MAX_TIMER_TTL_SECONDS) {
          return reply.code(400).send({ error: 'invalid_ttl' });
        }
      }

      const roomId = genRoomId();
      const room = {
        ownerPseudo: pseudo,
        pkOwner: publicKey,
        pkJoiner: null,
        joinerPseudo: null,
        expireMode,
        ttlSeconds: ttl,
        createdAt: Date.now(),
      };
      // Un salon inutilisé expire de lui-même après 24h pour ne pas accumuler
      // de métadonnées orphelines.
      await redis.set(roomKey(roomId), JSON.stringify(room), 'EX', 60 * 60 * 24);

      return reply.send({ roomId, expireMode, ttlSeconds: ttl });
    }
  );

  // Consultation d'un salon (par le second participant, via le lien partagé).
  fastify.get('/api/room/:roomId', async (request, reply) => {
    const pseudo = await requireAuth(request, reply);
    if (!pseudo) return;

    const raw = await redis.get(roomKey(request.params.roomId));
    if (!raw) return reply.code(404).send({ error: 'room_not_found' });
    const room = JSON.parse(raw);

    return reply.send({
      roomId: request.params.roomId,
      expireMode: room.expireMode,
      ttlSeconds: room.ttlSeconds,
      pkOwner: room.pkOwner,
      hasJoiner: Boolean(room.pkJoiner),
      isOwner: room.ownerPseudo === pseudo,
    });
  });

  // Rejoindre un salon en fournissant sa propre clé publique.
  fastify.post(
    '/api/room/:roomId/join',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const pseudo = await requireAuth(request, reply);
      if (!pseudo) return;

      const { publicKey } = request.body || {};
      if (typeof publicKey !== 'string' || publicKey.length < 32 || publicKey.length > 200) {
        return reply.code(400).send({ error: 'invalid_public_key' });
      }

      const key = roomKey(request.params.roomId);
      const raw = await redis.get(key);
      if (!raw) return reply.code(404).send({ error: 'room_not_found' });
      const room = JSON.parse(raw);

      if (room.ownerPseudo === pseudo) {
        return reply.code(400).send({ error: 'cannot_join_own_room' });
      }
      if (room.pkJoiner && room.joinerPseudo !== pseudo) {
        return reply.code(409).send({ error: 'room_full' });
      }

      room.pkJoiner = publicKey;
      room.joinerPseudo = pseudo;
      const ttl = await redis.ttl(key);
      await redis.set(key, JSON.stringify(room), 'EX', ttl > 0 ? ttl : 60 * 60 * 24);

      broadcastToRoom(request.params.roomId, {
        type: 'peer_joined',
        publicKey,
      }, { excludePseudo: pseudo });

      return reply.send({ roomId: request.params.roomId, pkOwner: room.pkOwner });
    }
  );
}
