// Registre en mémoire des connexions WebSocket actives par salon.
// Hypothèse MVP : une seule instance du serveur (pas de scaling horizontal).
// Si un jour plusieurs instances tournent derrière un load balancer, il
// faudra remplacer ça par du pub/sub Redis.

const rooms = new Map(); // roomId -> Set<{ socket, pseudo }>

export function registerConnection(roomId, pseudo, socket) {
  if (!rooms.has(roomId)) rooms.set(roomId, new Set());
  const entry = { socket, pseudo };
  rooms.get(roomId).add(entry);
  return () => {
    const set = rooms.get(roomId);
    if (!set) return;
    set.delete(entry);
    if (set.size === 0) rooms.delete(roomId);
  };
}

export function broadcastToRoom(roomId, payload, { excludePseudo } = {}) {
  const set = rooms.get(roomId);
  if (!set) return;
  const data = JSON.stringify(payload);
  for (const { socket, pseudo } of set) {
    if (excludePseudo && pseudo === excludePseudo) continue;
    if (socket.readyState === socket.OPEN) socket.send(data);
  }
}

// Ferme de force toutes les connexions d'un salon (ex: ticket supprimé par
// l'admin) — on ne se contente pas d'un message applicatif, la connexion
// elle-même est coupée pour éjecter vraiment le visiteur.
export function closeRoom(roomId, code, reason) {
  const set = rooms.get(roomId);
  if (!set) return;
  for (const { socket } of set) {
    if (socket.readyState === socket.OPEN) socket.close(code, reason);
  }
}

export function sendToPseudoInRoom(roomId, pseudo, payload) {
  const set = rooms.get(roomId);
  if (!set) return false;
  const data = JSON.stringify(payload);
  let sent = false;
  for (const entry of set) {
    if (entry.pseudo === pseudo && entry.socket.readyState === entry.socket.OPEN) {
      entry.socket.send(data);
      sent = true;
    }
  }
  return sent;
}
