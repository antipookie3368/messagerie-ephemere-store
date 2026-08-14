import { customAlphabet } from 'nanoid';
import { redis } from '../redis.js';
import { isAdminSession } from '../adminAuth.js';
import { registerConnection, sendToPseudoInRoom } from './registry.js';
import { ADMIN_LOBBY_ROOM } from '../routes/tickets.js';

const genMsgId = customAlphabet('0123456789abcdefghijklmnopqrstuvwxyz', 12);

const MESSAGE_TTL_SECONDS = 60 * 60 * 24; // fixe, aligné sur la durée de vie du ticket

function msgKey(ticketId, msgId) {
  return `msg:${ticketId}:${msgId}`;
}

function ticketKey(ticketId) {
  return `ticket:${ticketId}`;
}

async function loadTicket(ticketId) {
  const raw = await redis.get(ticketKey(ticketId));
  return raw ? JSON.parse(raw) : null;
}

export default async function wsRoutes(fastify) {
  fastify.get('/ws', { websocket: true }, async (connection, request) => {
    const socket = connection.socket ?? connection; // compat selon version @fastify/websocket
    const { ticketId, accessToken, adminSessionToken } = request.query;

    let role; // 'visitor' | 'admin'
    let roomId;

    if (adminSessionToken) {
      const ok = await isAdminSession(adminSessionToken);
      if (!ok) {
        socket.close(4001, 'unauthorized');
        return;
      }
      role = 'admin';
      if (ticketId) {
        const ticket = await loadTicket(ticketId);
        if (!ticket) {
          socket.close(4004, 'ticket_not_found');
          return;
        }
        roomId = ticketId;
      } else {
        // Connexion "tableau de bord" : reçoit les notifications de nouveaux
        // tickets, sans être rattachée à un ticket précis.
        roomId = ADMIN_LOBBY_ROOM;
      }
    } else if (ticketId && accessToken) {
      const ticket = await loadTicket(ticketId);
      if (!ticket || ticket.accessToken !== accessToken) {
        socket.close(4001, 'unauthorized');
        return;
      }
      role = 'visitor';
      roomId = ticketId;
    } else {
      socket.close(4000, 'missing_params');
      return;
    }

    const unregister = registerConnection(roomId, role, socket);
    const isLobby = roomId === ADMIN_LOBBY_ROOM;

    if (!isLobby) {
      const pending = await deliverPendingMessages(roomId, role);
      for (const payload of pending) {
        socket.send(JSON.stringify(payload));
      }
    }

    socket.on('message', async (raw) => {
      if (isLobby) return; // le salon admin-lobby ne relaie pas de messages
      let data;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        return; // ignore les payloads malformés
      }

      if (data.type === 'message') {
        await handleIncomingMessage(roomId, role, data, socket);
      }
    });

    socket.on('close', () => {
      unregister();
    });
  });
}

async function handleIncomingMessage(ticketId, fromRole, data, socket) {
  const { ciphertext, nonce } = data;

  if (typeof ciphertext !== 'string' || typeof nonce !== 'string') return;

  // Filet de sécurité contre une course avec une suppression admin en cours :
  // si le ticket vient de disparaître, on n'écrit rien.
  const ticket = await loadTicket(ticketId);
  if (!ticket) {
    socket.close(4004, 'ticket_not_found');
    return;
  }

  const recipientRole = fromRole === 'visitor' ? 'admin' : 'visitor';
  const msgId = genMsgId();
  const payload = { ciphertext, nonce, from: fromRole };

  await redis.set(msgKey(ticketId, msgId), JSON.stringify(payload), 'EX', MESSAGE_TTL_SECONDS);

  const delivered = sendToPseudoInRoom(ticketId, recipientRole, {
    type: 'message',
    msgId,
    ciphertext,
    nonce,
    from: fromRole,
  });

  socket.send(JSON.stringify({ type: 'sent_ack', msgId, delivered }));
}

async function deliverPendingMessages(ticketId, myRole) {
  const results = [];
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `msg:${ticketId}:*`, 'COUNT', 100);
    cursor = next;
    for (const key of keys) {
      const raw = await redis.get(key);
      if (!raw) continue;
      const payload = JSON.parse(raw);
      if (payload.from !== myRole) {
        const msgId = key.split(':').pop();
        results.push({
          type: 'message',
          msgId,
          ciphertext: payload.ciphertext,
          nonce: payload.nonce,
          from: payload.from,
        });
      }
    }
  } while (cursor !== '0');
  return results;
}
