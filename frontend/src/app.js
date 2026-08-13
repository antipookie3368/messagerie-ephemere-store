import { initCrypto, generateKeyPair, toBase64, encryptMessage, decryptMessage } from './crypto.js';
import { connectRoomSocket } from './ws-client.js';

// La clé privée ne vit qu'en mémoire JS, jamais dans localStorage/sessionStorage.
// Un rechargement de page = nouvelle identité de session = salon perdu.
// C'est un choix assumé, cohérent avec l'esprit "éphémère" du service.
let myKeyPair = null;
let peerPublicKeyB64 = null;
let sessionToken = sessionStorage.getItem('sessionToken');
let pseudo = sessionStorage.getItem('pseudo');
let socket = null;
let currentRoomId = null;

const $ = (sel) => document.querySelector(sel);

function show(viewId) {
  for (const el of document.querySelectorAll('.view')) el.classList.add('hidden');
  $(`#${viewId}`).classList.remove('hidden');
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}),
      ...(options.headers || {}),
    },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `http_${res.status}`);
  return body;
}

function addMessageToLog(text, { fromMe, msgId, mode }) {
  const log = $('#message-log');
  const line = document.createElement('div');
  line.className = `msg ${fromMe ? 'msg-me' : 'msg-peer'}`;
  line.textContent = text;
  if (msgId) line.dataset.msgId = msgId;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  return line;
}

function systemNote(text) {
  const log = $('#message-log');
  const line = document.createElement('div');
  line.className = 'msg-system';
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

async function handleRegister(evt) {
  evt.preventDefault();
  const value = $('#pseudo-input').value.trim();
  try {
    const data = await api('/api/register', { method: 'POST', body: JSON.stringify({ pseudo: value }) });
    sessionToken = data.sessionToken;
    pseudo = data.pseudo;
    sessionStorage.setItem('sessionToken', sessionToken);
    sessionStorage.setItem('pseudo', pseudo);
    afterAuth();
  } catch (err) {
    $('#auth-error').textContent = translateError(err.message);
  }
}

async function handleCreateRoom(evt) {
  evt.preventDefault();
  myKeyPair = generateKeyPair();
  const defaultMode = $('#default-mode').value;
  const defaultTtl = Number($('#default-ttl').value);

  try {
    const data = await api('/api/room', {
      method: 'POST',
      body: JSON.stringify({
        publicKey: toBase64(myKeyPair.publicKey),
        expireMode: defaultMode,
        ttlSeconds: defaultMode === 'timer' ? defaultTtl : undefined,
      }),
    });
    currentRoomId = data.roomId;
    const link = `${location.origin}/#room=${data.roomId}`;
    $('#room-link').value = link;
    $('#room-link-box').classList.remove('hidden');
    openChat({ isOwner: true });
  } catch (err) {
    $('#lobby-error').textContent = translateError(err.message);
  }
}

async function handleJoinRoom(roomId) {
  myKeyPair = generateKeyPair();
  try {
    const roomInfo = await api(`/api/room/${roomId}`);
    peerPublicKeyB64 = roomInfo.pkOwner;

    await api(`/api/room/${roomId}/join`, {
      method: 'POST',
      body: JSON.stringify({ publicKey: toBase64(myKeyPair.publicKey) }),
    });

    currentRoomId = roomId;
    openChat({ isOwner: false });
  } catch (err) {
    $('#lobby-error').textContent = translateError(err.message);
    show('lobby-view');
  }
}

function openChat({ isOwner }) {
  show('chat-view');
  systemNote(isOwner
    ? "Salon créé. En attente de l'autre personne..."
    : 'Salon rejoint. Connexion en cours...');

  socket = connectRoomSocket({
    sessionToken,
    roomId: currentRoomId,
    onOpen: () => systemNote('Connecté.'),
    onPeerJoined: (data) => {
      peerPublicKeyB64 = data.publicKey;
      systemNote('L\'autre personne a rejoint le salon. Vous pouvez discuter.');
    },
    onMessage: (data) => {
      try {
        const plaintext = decryptMessage(data.ciphertext, data.nonce, peerPublicKeyB64, myKeyPair.privateKey);
        const line = addMessageToLog(plaintext, { fromMe: false, msgId: data.msgId, mode: data.mode });
        if (data.mode === 'read') {
          // Purge dès l'affichage : c'est la définition du mode "lecture".
          socket.ackRead(data.msgId);
          line.classList.add('msg-burned');
        }
      } catch {
        systemNote('Message reçu illisible (clé invalide ou message altéré).');
      }
    },
    onPurged: (data) => {
      markBurned(data.msgId);
    },
    onExpired: (data) => {
      markBurned(data.msgId, 'Message expiré');
    },
  });
}

function markBurned(msgId, label = 'Message supprimé') {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (el) {
    el.textContent = label;
    el.classList.add('msg-burned');
  }
}

function handleSend(evt) {
  evt.preventDefault();
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text || !peerPublicKeyB64) return;

  const mode = $('#send-mode').value;
  const ttlSeconds = Number($('#send-ttl').value);

  const { ciphertext, nonce } = encryptMessage(text, peerPublicKeyB64, myKeyPair.privateKey);
  socket.sendMessage({ ciphertext, nonce, mode, ttlSeconds: mode === 'timer' ? ttlSeconds : undefined });

  addMessageToLog(text, { fromMe: true });
  input.value = '';
}

function afterAuth() {
  $('#whoami').textContent = pseudo;
  const hashMatch = location.hash.match(/^#room=(.+)$/);
  if (hashMatch) {
    show('lobby-view');
    handleJoinRoom(hashMatch[1]);
  } else {
    show('lobby-view');
  }
}

function translateError(code) {
  const map = {
    invalid_pseudo: '3 à 24 caractères, lettres/chiffres/-/_ uniquement.',
    pseudo_taken: 'Ce pseudo est déjà pris.',
    room_not_found: 'Salon introuvable ou expiré.',
    room_full: 'Ce salon a déjà deux participants.',
    cannot_join_own_room: 'Vous ne pouvez pas rejoindre votre propre salon.',
    unauthorized: 'Session invalide, reconnectez-vous.',
  };
  return map[code] || 'Une erreur est survenue.';
}

async function main() {
  await initCrypto();
  $('#register-form').addEventListener('submit', handleRegister);
  $('#create-room-form').addEventListener('submit', handleCreateRoom);
  $('#send-form').addEventListener('submit', handleSend);
  $('#send-mode').addEventListener('change', () => {
    $('#send-ttl').classList.toggle('hidden', $('#send-mode').value !== 'timer');
  });
  $('#default-mode').addEventListener('change', () => {
    $('#default-ttl').classList.toggle('hidden', $('#default-mode').value !== 'timer');
  });

  if (sessionToken && pseudo) {
    afterAuth();
  } else {
    show('auth-view');
  }
}

main();
