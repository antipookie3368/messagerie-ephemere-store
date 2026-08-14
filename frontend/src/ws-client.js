// Client WebSocket minimal : connexion, envoi de messages chiffrés, dispatch
// des événements reçus. Ne manipule jamais de clé privée ni de texte en
// clair : uniquement des blobs déjà chiffrés par crypto.js.

export function connectSocket(params, { onMessage, onExpired, onNewTicket, onTicketDeleted, onTicketRemoved, onTicketUpdated, onVisitorRejoined, onOpen, onClose } = {}) {
  const protocol = location.protocol === 'https:' ? 'wss' : 'ws';
  const qs = new URLSearchParams(params).toString();
  const url = `${protocol}://${location.host}/ws?${qs}`;
  const socket = new WebSocket(url);

  socket.addEventListener('open', () => onOpen?.());
  socket.addEventListener('close', (event) => onClose?.(event));

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
      case 'expired':
        onExpired?.(data);
        break;
      case 'new_ticket':
        onNewTicket?.(data);
        break;
      case 'ticket_deleted':
        onTicketDeleted?.(data);
        break;
      case 'ticket_removed':
        onTicketRemoved?.(data);
        break;
      case 'ticket_updated':
        onTicketUpdated?.(data);
        break;
      case 'visitor_rejoined':
        onVisitorRejoined?.(data);
        break;
      default:
        break;
    }
  });

  return {
    raw: socket,
    sendMessage({ ciphertext, nonce }) {
      socket.send(JSON.stringify({ type: 'message', ciphertext, nonce }));
    },
    close() {
      socket.close();
    },
  };
}
