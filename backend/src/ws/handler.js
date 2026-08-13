import { customAlphabet } from 'nanoid';
import { redis } from '../redis.js';
import { getPseudoFromToken } from '../auth.js';
import { registerConnection, sendToPseudoInRoom } from './registry.js';

const genMsgId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

const SAFETY_TTL_SECONDS = 60 * 60 * 24 * 7; // filet de sécurité pour le mode "lecture"

function msgKey(roomId, msgId) {
  return `msg:${roomId}:${msgId}`;
}

function roomKey(roomId) {
  return `room:${roomId}`;
}

async function loadRoom(roomId) {
  const raw = await redis.get(roomKey(roomId));
  return raw ? JSON.parse(raw) : null;
}

function otherPseudo(room, pseudo) {
  if (room.ownerPseudo === pseudo) return room.joinerPseudo;
  if (room.joinerPseudo === pseudo) return room.ownerPseudo;
  return null;
}

export default async function wsRoutes(fastify) {
  fastify.get('/ws', { websocket: true }, async (connection, request) => {
    const socket = connection.socket ?? connection; // compat selon version @fastify/websocket
    const { token, roomId } = request.query;

    const pseudo = await getPseudoFromToken(token);
    if (!pseudo) {
      socket.close(4001, 'unauthorized');
      return;
    }

    const room = await loadRoom(roomId);
    if (!room || (room.ownerPseudo !== pseudo && room.joinerPseudo !== pseudo)) {
      socket.close(4004, 'room_not_found_or_forbidden');
      return;
    }

    const unregister = registerConnection(roomId, pseudo, socket);

    // Délivrer les messages en attente adressés à cet utilisateur.
    const pending = await deliverPendingMessages(roomId, pseudo);
    for (const payload of pending) {
      socket.send(JSON.stringify(payload));
    }

    socket.on('message', async (raw) => {
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return; // ignore les payloads malformés
      }

      if (data.type === 'message') {
        await handleIncomingMessage(roomId, pseudo, room, data, socket);
      } else if (data.type === 'ack_read') {
        await handleAckRead(roomId, pseudo, data);
      }
    });

    socket.on('close', () => {
      unregister();
    });
  });
}

async function handleIncomingMessage(roomId, fromPseudo, room, data, socket) {
  const { ciphertext, nonce, mode, ttlSeconds } = data;

  if (typeof ciphertext !== 'string' || typeof nonce !== 'string') return;
  if (!['read', 'timer'].includes(mode)) return;

  const recipient = otherPseudo(room, fromPseudo);
  if (!recipient) return; // pas encore de second participant

  const msgId = genMsgId();
  const payload = { ciphertext, nonce, from: fromPseudo, mode };

  if (mode === 'timer') {
    const ttl = Math.min(Math.max(Number(ttlSeconds) || 300, 30), 60 * 60 * 24);
    await redis.set(msgKey(roomId, msgId), JSON.stringify(payload), 'EX', ttl);
  } else {
    // mode "lecture" : pas d'expiration métier, mais un filet de sécurité
    // pour ne jamais accumuler indéfiniment si le destinataire ne revient pas.
    await redis.set(msgKey(roomId, msgId), JSON.stringify(payload), 'EX', SAFETY_TTL_SECONDS);
  }

  const delivered = sendToPseudoInRoom(roomId, recipient, {
    type: 'message',
    msgId,
    ciphertext,
    nonce,
    from: fromPseudo,
    mode,
  });

  socket.send(JSON.stringify({ type: 'sent_ack', msgId, delivered }));
}

async function handleAckRead(roomId, pseudo, data) {
  const { msgId } = data;
  if (typeof msgId !== 'string') return;

  const key = msgKey(roomId, msgId);
  const raw = await redis.get(key);
  if (!raw) return;
  const payload = JSON.parse(raw);

  // Seul le destinataire (pas l'auteur) peut déclencher la purge à la lecture.
  if (payload.from === pseudo || payload.mode !== 'read') return;

  await redis.del(key);
  sendToPseudoInRoom(roomId, payload.from, { type: 'purged', msgId });
}

async function deliverPendingMessages(roomId, pseudo) {
  const results = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `msg:${roomId}:*`, 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const payload = JSON.parse(raw);
      if (payload.from !== pseudo) {
        const msgId = key.split(':').pop();
        results.push({
          type: 'message',
          msgId,
          ciphertext: payload.ciphertext,
          nonce: payload.nonce,
          from: payload.from,
          mode: payload.mode,
        });
      }
    }
  } while (cursor !== '0');
  return results;
}
