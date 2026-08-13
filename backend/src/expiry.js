import { redisSub, enableExpiryNotifications } from './redis.js';
import { broadcastToRoom } from './ws/registry.js';

// Écoute les expirations natives Redis (mode "délai") pour prévenir les
// clients connectés que le message a été purgé, même si personne ne l'a lu.
export async function startExpiryListener() {
  await enableExpiryNotifications();
  await redisSub.psubscribe('__keyevent@*__:expired');

  redisSub.on('pmessage', (_pattern, _channel, expiredKey) => {
    // Format de clé : msg:<roomId>:<msgId>
    const parts = expiredKey.split(':');
    if (parts.length !== 3 || parts[0] !== 'msg') return;
    const [, roomId, msgId] = parts;
    broadcastToRoom(roomId, { type: 'expired', msgId });
  });
}
