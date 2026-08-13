// Client WebSocket minimal : connexion au salon, envoi de messages chiffrés,
// dispatch des événements reçus vers des callbacks fournis par app.js.
// Ce module ne connaît jamais de clé privée ni de texte en clair : il ne
// manipule que des blobs déjà chiffrés par crypto.js.

export function connectRoomSocket({ sessionToken, roomId, onMessage, onPeerJoined, onPurged, onExpired, onOpen }) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const url = `${protocol}://${location.host}/ws?token=${encodeURIComponent(sessionToken)}&roomId=${encodeURIComponent(roomId)}`;
  const socket = new WebSocket(url);

  socket.addEventListener('open', () => onOpen?.());

  socket.addEventListener('message', (event) => {
    let data;
    try {
      data = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (data.type) {
      case 'message':
        onMessage?.(data);
        break;
      case 'peer_joined':
        onPeerJoined?.(data);
        break;
      case 'purged':
        onPurged?.(data);
        break;
      case 'expired':
        onExpired?.(data);
        break;
      default:
        break;
    }
  });

  return {
    raw: socket,
    sendMessage({ ciphertext, nonce, mode, ttlSeconds }) {
      socket.send(JSON.stringify({ type: 'message', ciphertext, nonce, mode, ttlSeconds }));
    },
    ackRead(msgId) {
      socket.send(JSON.stringify({ type: 'ack_read', msgId }));
    },
    close() {
      socket.close();
    },
  };
}
