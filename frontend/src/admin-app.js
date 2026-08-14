import {
  initCrypto,
  generateKeyPair,
  toBase64,
  fromBase64,
  encryptMessage,
  decryptMessage,
  wrapPrivateKeyWithPassword,
  unwrapPrivateKeyWithPassword,
} from './crypto.js';
import { connectSocket } from './ws-client.js';

// L'identité de chiffrement de l'admin (paire de clés) est mise en cache
// dans ce navigateur (localStorage) pour aller vite, mais elle est aussi
// recouvrable sur n'importe quel appareil : la clé privée est stockée côté
// serveur chiffrée avec un secret dérivé du mot de passe admin (Argon2id).
// Le serveur ne voit jamais le mot de passe en clair au-delà de la requête
// de login, ni la clé dérivée — tout le déchiffrement se fait ici.
const SESSION_KEY = 'adminSessionToken';
const IDENTITY_KEY = 'adminIdentity';

let sessionToken = localStorage.getItem(SESSION_KEY);
let identity = null; // { privateKey: Uint8Array, publicKey: Uint8Array }
let lobbySocket = null;
let ticketSocket = null;
let currentTicket = null; // { ticketId, visitorPublicKey }
const ticketsById = new Map();
let lobbyReconnectAttempts = 0;
let lobbyReconnectTimer = null;

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

function logout() {
  sessionToken = null;
  localStorage.removeItem(SESSION_KEY);
  show('login-view');
}

async function handleLogin(evt) {
  evt.preventDefault();
  const password = $('#password-input').value;
  const submitBtn = evt.target.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Connexion...';
  $('#login-error').textContent = '';
  try {
    const data = await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password }) });
    sessionToken = data.adminSessionToken;
    localStorage.setItem(SESSION_KEY, sessionToken);
    await afterLogin(password);
  } catch {
    $('#login-error').textContent = 'Mot de passe incorrect.';
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Se connecter';
  }
}

function loadIdentity() {
  const raw = localStorage.getItem(IDENTITY_KEY);
  if (!raw) return null;
  const parsed = JSON.parse(raw);
  return { privateKey: fromBase64(parsed.privateKey), publicKey: fromBase64(parsed.publicKey) };
}

// `password` vient directement du formulaire de login quand disponible ; à
// défaut (reprise de session existante), on ne le redemande que si une
// récupération de clé s'avère nécessaire.
async function ensureIdentity(password) {
  const stored = loadIdentity();
  if (stored) {
    identity = stored;
    // Migration best-effort pour une identité créée avant l'ajout de la
    // récupération par mot de passe : on publie une sauvegarde chiffrée si
    // aucune n'existe encore côté serveur (uniquement possible juste après
    // un login, quand on a le mot de passe en mémoire).
    if (password) {
      try {
        await api('/api/admin/identity');
      } catch {
        const wrapped = wrapPrivateKeyWithPassword(identity.privateKey, password);
        await api('/api/admin/public-key', {
          method: 'POST',
          body: JSON.stringify({ publicKey: toBase64(identity.publicKey), ...wrapped }),
        }).catch(() => {});
      }
    }
    return;
  }

  let blob = null;
  try {
    blob = await api('/api/admin/identity');
  } catch {
    blob = null; // pas encore configuré : première mise en place
  }

  if (blob) {
    if (!password) {
      password = prompt('Ressaisis le mot de passe admin pour récupérer ton identité de chiffrement sur ce navigateur :') || '';
    }
    try {
      const privateKey = unwrapPrivateKeyWithPassword(blob.encryptedPrivateKey, blob.nonce, blob.salt, password);
      identity = { privateKey, publicKey: fromBase64(blob.publicKey) };
      localStorage.setItem(IDENTITY_KEY, JSON.stringify({ privateKey: toBase64(privateKey), publicKey: blob.publicKey }));
      return;
    } catch {
      alert("Mot de passe incorrect pour récupérer l'identité existante.");
      throw new Error('identity_recovery_failed');
    }
  }

  if (!password) {
    password = prompt('Nouvelle identité de chiffrement : ressaisis le mot de passe admin pour la protéger :') || '';
  }
  identity = generateKeyPair();
  const wrapped = wrapPrivateKeyWithPassword(identity.privateKey, password);
  localStorage.setItem(IDENTITY_KEY, JSON.stringify({
    privateKey: toBase64(identity.privateKey),
    publicKey: toBase64(identity.publicKey),
  }));
  await api('/api/admin/public-key', {
    method: 'POST',
    body: JSON.stringify({ publicKey: toBase64(identity.publicKey), ...wrapped }),
  });
}

function formatDateTime(ms) {
  return new Date(ms).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function ticketStatus(t) {
  return t.expiresAt > Date.now() ? 'active' : 'expired';
}

function renderTicketList() {
  const list = $('#ticket-list');
  list.innerHTML = '';
  const sorted = [...ticketsById.values()].sort((a, b) => b.createdAt - a.createdAt);
  for (const t of sorted) {
    const status = ticketStatus(t);
    const item = document.createElement('div');
    item.className = 'ticket-item' + (currentTicket?.ticketId === t.ticketId ? ' active' : '');

    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'ticket-item-open';
    openBtn.innerHTML = `
      <span class="ticket-item-pseudo">${escapeHtml(t.pseudo || '(sans pseudo)')}</span>
      <span class="ticket-item-status status-${status}">${status === 'active' ? 'active' : 'expirée'}</span>
      <span class="ticket-item-dates">créée ${formatDateTime(t.createdAt)} · expire ${formatDateTime(t.expiresAt)}</span>
    `;
    openBtn.addEventListener('click', () => openTicketDetail(t.ticketId, t.visitorPublicKey, t.pseudo));

    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'ticket-item-delete';
    deleteBtn.textContent = 'Supprimer';
    deleteBtn.title = 'Supprimer cette discussion';
    deleteBtn.addEventListener('click', (evt) => {
      evt.stopPropagation();
      deleteTicket(t.ticketId);
    });

    item.appendChild(openBtn);
    item.appendChild(deleteBtn);
    list.appendChild(item);
  }
  if (sorted.length === 0) {
    list.innerHTML = '<p class="hint">Aucune discussion pour le moment.</p>';
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

async function loadTicketList() {
  const { tickets } = await api('/api/admin/tickets');
  ticketsById.clear();
  for (const t of tickets) ticketsById.set(t.ticketId, t);
  renderTicketList();
}

function removeTicketLocally(ticketId) {
  ticketsById.delete(ticketId);
  if (currentTicket?.ticketId === ticketId) {
    if (ticketSocket) ticketSocket.close();
    ticketSocket = null;
    currentTicket = null;
    $('#detail-header').classList.add('hidden');
    $('#message-log').classList.add('hidden');
    $('#send-form').classList.add('hidden');
    $('#detail-placeholder').classList.remove('hidden');
    $('#detail-placeholder').textContent = 'Sélectionne une discussion à gauche.';
  }
  renderTicketList();
}

async function deleteTicket(ticketId) {
  if (!confirm('Supprimer définitivement cette discussion ?')) return;
  try {
    await api(`/api/admin/tickets/${ticketId}`, { method: 'DELETE' });
    removeTicketLocally(ticketId);
  } catch {
    alert('Échec de la suppression.');
  }
}

function scheduleLobbyReconnect() {
  lobbyReconnectAttempts += 1;
  const delaySeconds = Math.min(2 ** lobbyReconnectAttempts, 15);
  clearTimeout(lobbyReconnectTimer);
  lobbyReconnectTimer = setTimeout(connectLobby, delaySeconds * 1000);
}

function connectLobby() {
  lobbySocket = connectSocket(
    { adminSessionToken: sessionToken },
    {
      onOpen: () => {
        lobbyReconnectAttempts = 0;
      },
      onNewTicket: (data) => {
        ticketsById.set(data.ticketId, {
          ticketId: data.ticketId,
          pseudo: data.pseudo,
          createdAt: data.createdAt,
          expiresAt: data.expiresAt,
          visitorPublicKey: data.visitorPublicKey,
        });
        renderTicketList();
      },
      onTicketRemoved: (data) => removeTicketLocally(data.ticketId),
      onTicketUpdated: (data) => {
        const t = ticketsById.get(data.ticketId);
        if (t) t.visitorPublicKey = data.visitorPublicKey;
        if (currentTicket?.ticketId === data.ticketId) currentTicket.visitorPublicKey = data.visitorPublicKey;
      },
      onClose: (event) => {
        if (event.code === 4001) {
          logout();
          return;
        }
        scheduleLobbyReconnect();
      },
    }
  );
}

function addMessageToLog(text, { fromMe, msgId }) {
  const log = $('#message-log');
  const line = document.createElement('div');
  line.className = `msg ${fromMe ? 'msg-me' : 'msg-peer'}`;
  line.textContent = text;
  if (msgId) line.dataset.msgId = msgId;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
  return line;
}

function markExpired(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (el) {
    el.textContent = 'Message expiré';
    el.classList.add('msg-burned');
  }
}

function openTicketDetail(ticketId, visitorPublicKey, pseudo) {
  if (ticketSocket) ticketSocket.close();

  currentTicket = { ticketId, visitorPublicKey };
  renderTicketList();

  $('#detail-placeholder').classList.add('hidden');
  $('#detail-header').textContent = pseudo || ticketId;
  $('#detail-header').classList.remove('hidden');
  $('#message-log').classList.remove('hidden');
  $('#send-form').classList.remove('hidden');
  $('#message-log').innerHTML = '';

  ticketSocket = connectSocket(
    { adminSessionToken: sessionToken, ticketId },
    {
      onMessage: (data) => {
        try {
          const plaintext = decryptMessage(data.ciphertext, data.nonce, visitorPublicKey, identity.privateKey);
          addMessageToLog(plaintext, { fromMe: false, msgId: data.msgId });
        } catch {
          addMessageToLog('Message illisible (altéré).', { fromMe: false });
        }
      },
      onExpired: (data) => markExpired(data.msgId),
    }
  );
}

function handleSend(evt) {
  evt.preventDefault();
  if (!currentTicket) return;
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text) return;

  if (!ticketSocket || ticketSocket.raw.readyState !== WebSocket.OPEN) {
    alert('Pas encore connecté à cette discussion, réessaie dans un instant.');
    return;
  }

  const { ciphertext, nonce } = encryptMessage(text, currentTicket.visitorPublicKey, identity.privateKey);
  ticketSocket.sendMessage({ ciphertext, nonce });

  addMessageToLog(text, { fromMe: true });
  input.value = '';
}

async function afterLogin(password) {
  await ensureIdentity(password);
  show('dashboard-view');
  connectLobby();
  await loadTicketList();
}

async function main() {
  await initCrypto();
  $('#login-form').addEventListener('submit', handleLogin);
  $('#send-form').addEventListener('submit', handleSend);

  if (sessionToken) {
    try {
      await afterLogin();
    } catch {
      logout();
    }
  } else {
    show('login-view');
  }
}

main();
