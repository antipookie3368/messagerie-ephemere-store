import { customAlphabet } from 'nanoid';
import { redis } from '../redis.js';
import { requireAdmin } from '../adminAuth.js';
import { broadcastToRoom, closeRoom } from '../ws/registry.js';

const genId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 16);
const genAccessToken = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ', 40);

const TICKET_TTL_SECONDS = 60 * 60 * 24; // 24h fixes depuis la création, non glissantes
const PSEUDO_REGEX = /^[a-zA-Z0-9_-]{3,24}$/;
export const ADMIN_LOBBY_ROOM = 'admin-lobby';

function ticketKey(ticketId) {
  return `ticket:${ticketId}`;
}

function pseudoIndexKey(pseudo) {
  return `pseudo_index:${pseudo.toLowerCase()}`;
}

export default async function ticketRoutes(fastify) {
  // Création (ou reprise) d'un ticket par un visiteur anonyme. Pas
  // d'authentification : seul un rate limit par IP protège contre le spam.
  //
  // Choix produit assumé : retaper un pseudo déjà actif reprend la même
  // discussion (pratique pour un usage perso à faible volume), au prix que
  // le pseudo devient de facto la clé d'accès — quiconque le devine peut
  // lire la conversation. Documenté, accepté par le déploiement.
  fastify.post(
    '/api/tickets',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (request, reply) => {
      const { pseudo, publicKey } = request.body || {};

      if (typeof pseudo !== 'string' || !PSEUDO_REGEX.test(pseudo)) {
        return reply.code(400).send({
          error: 'invalid_pseudo',
          message: '3 à 24 caractères, lettres/chiffres/-/_ uniquement.',
        });
      }
      if (typeof publicKey !== 'string' || publicKey.length < 32 || publicKey.length > 200) {
        return reply.code(400).send({ error: 'invalid_public_key' });
      }

      const adminPublicKey = await redis.get('admin:public_key');
      if (!adminPublicKey) {
        return reply.code(503).send({ error: 'admin_not_configured' });
      }

      const existingTicketId = await redis.get(pseudoIndexKey(pseudo));
      if (existingTicketId) {
        const existingRaw = await redis.get(ticketKey(existingTicketId));
        if (existingRaw) {
          const existing = JSON.parse(existingRaw);
          const ttl = await redis.ttl(ticketKey(existingTicketId));
          // Nouvelle session = nouvelle paire de clés côté visiteur : on met
          // à jour la clé publique enregistrée pour que les prochains
          // messages se chiffrent correctement (les anciens messages en
          // attente, chiffrés pour l'ancienne clé, ne seront eux plus lisibles).
          const updated = { ...existing, visitorPublicKey: publicKey };
          await redis.set(ticketKey(existingTicketId), JSON.stringify(updated), 'EX', ttl > 0 ? ttl : TICKET_TTL_SECONDS);

          broadcastToRoom(existingTicketId, { type: 'visitor_rejoined', visitorPublicKey: publicKey });
          broadcastToRoom(ADMIN_LOBBY_ROOM, {
            type: 'ticket_updated',
            ticketId: existingTicketId,
            visitorPublicKey: publicKey,
          });

          return reply.send({
            ticketId: existingTicketId,
            accessToken: existing.accessToken,
            adminPublicKey,
            createdAt: existing.createdAt,
            expiresAt: existing.expiresAt,
            resumed: true,
          });
        }
        // Index orphelin (rare course avec une expiration) : on nettoie et on continue.
        await redis.del(pseudoIndexKey(pseudo));
      }

      const ticketId = genId();
      const accessToken = genAccessToken();
      const createdAt = Date.now();
      const expiresAt = createdAt + TICKET_TTL_SECONDS * 1000;

      const reserved = await redis.set(pseudoIndexKey(pseudo), ticketId, 'NX', 'EX', TICKET_TTL_SECONDS);
      if (!reserved) {
        return reply.code(409).send({ error: 'pseudo_taken' });
      }

      await redis.set(
        ticketKey(ticketId),
        JSON.stringify({ pseudo, visitorPublicKey: publicKey, accessToken, createdAt, expiresAt }),
        'EX',
        TICKET_TTL_SECONDS
      );

      broadcastToRoom(ADMIN_LOBBY_ROOM, {
        type: 'new_ticket',
        ticketId,
        pseudo,
        createdAt,
        expiresAt,
        visitorPublicKey: publicKey,
      });

      return reply.send({ ticketId, accessToken, adminPublicKey, createdAt, expiresAt });
    }
  );

  // Liste des tickets actifs pour le tableau de bord admin. Redis n'expose
  // jamais un ticket dont le TTL est écoulé (SCAN suffit, pas d'index séparé).
  fastify.get('/api/admin/tickets', async (request, reply) => {
    const ok = await requireAdmin(request, reply);
    if (!ok) return;

    const tickets = [];
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', 'ticket:*', 'COUNT', 100);
      cursor = next;
      for (const key of keys) {
        const raw = await redis.get(key);
        if (!raw) continue;
        const data = JSON.parse(raw);
        tickets.push({
          ticketId: key.slice('ticket:'.length),
          pseudo: data.pseudo,
          createdAt: data.createdAt,
          expiresAt: data.expiresAt,
          status: data.expiresAt > Date.now() ? 'active' : 'expired',
          visitorPublicKey: data.visitorPublicKey,
        });
      }
    } while (cursor !== '0');

    tickets.sort((a, b) => b.createdAt - a.createdAt);
    return reply.send({ tickets });
  });

  // Suppression manuelle d'une discussion par l'admin : purge le ticket,
  // ses messages et l'index de pseudo, et prévient tout le monde de connecté.
  fastify.delete('/api/admin/tickets/:ticketId', async (request, reply) => {
    const ok = await requireAdmin(request, reply);
    if (!ok) return;

    const { ticketId } = request.params;
    const raw = await redis.get(ticketKey(ticketId));
    if (!raw) return reply.code(404).send({ error: 'ticket_not_found' });
    const data = JSON.parse(raw);

    await redis.del(ticketKey(ticketId));
    if (data.pseudo) await redis.del(pseudoIndexKey(data.pseudo));

    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(cursor, 'MATCH', `msg:${ticketId}:*`, 'COUNT', 100);
      cursor = next;
      if (keys.length > 0) await redis.del(...keys);
    } while (cursor !== '0');

    // Notifie d'abord (le visiteur affiche un message clair), puis coupe
    // la connexion pour de vrai — pas de simple notification applicative.
    broadcastToRoom(ticketId, { type: 'ticket_deleted' });
    closeRoom(ticketId, 4010, 'ticket_deleted');
    broadcastToRoom(ADMIN_LOBBY_ROOM, { type: 'ticket_removed', ticketId });

    return reply.send({ ok: true });
  });
}
