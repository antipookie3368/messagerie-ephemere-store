import { initCrypto, deriveVisitorKeyPair, toBase64, decryptMessage, encryptMessage } from './crypto.js';
import { connectSocket } from './ws-client.js';

// La paire de clés du visiteur est dérivée déterministiquement du pseudo
// (voir crypto.js: deriveVisitorKeyPair) : retaper le même pseudo la
// recalcule à l'identique, donc rien de critique à perdre si le
// localStorage disparaît. Ce qu'on y cache (ticketId, accessToken) n'est
// qu'un raccourci pour éviter de repasser par la reprise à chaque visite.
const STORAGE_KEY = 'ticket';

let socket = null;
let keyPair = null;
let adminPublicKeyB64 = null;
let ticket = null; // { ticketId, accessToken, pseudo, createdAt, expiresAt }
let reconnectAttempts = 0;
let reconnectTimer = null;
let expiryInterval = null;

const $ = (sel) => document.querySelector(sel);

function show(viewId) {
  for (const el of document.querySelectorAll('.view')) el.classList.add('hidden');
  $(`#${viewId}`).classList.remove('hidden');
}

function loadStoredTicket() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveTicket(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function clearTicket() {
  localStorage.removeItem(STORAGE_KEY);
  clearInterval(expiryInterval);
  clearTimeout(reconnectTimer);
}

function setConnectionStatus(text) {
  $('#connection-status').textContent = text;
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

function systemNote(text) {
  const log = $('#message-log');
  const line = document.createElement('div');
  line.className = 'msg-system';
  line.textContent = text;
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}

function markExpired(msgId) {
  const el = document.querySelector(`[data-msg-id="${msgId}"]`);
  if (el) {
    el.textContent = 'Message expiré';
    el.classList.add('msg-burned');
  }
}

function showExpiredView(message = 'Cette discussion a expiré (24h écoulées) et a été supprimée.') {
  clearTicket();
  $('#expired-message').textContent = message;
  show('expired-view');
}

function updateExpiryNote() {
  if (!ticket) return;
  // L'affichage se base sur expiresAt renvoyé par le serveur (autorité sur
  // le calcul), pas sur une durée recalculée localement dans le navigateur.
  const remainingMs = ticket.expiresAt - Date.now();
  if (remainingMs <= 0) {
    showExpiredView();
    return;
  }
  const h = Math.floor(remainingMs / 3600000);
  const m = Math.floor((remainingMs % 3600000) / 60000);
  $('#ticket-expiry').textContent = `Expire dans ${h}h${String(m).padStart(2, '0')}`;
}

function scheduleReconnect() {
  reconnectAttempts += 1;
  const delaySeconds = Math.min(2 ** reconnectAttempts, 15);
  setConnectionStatus(`Connexion perdue. Nouvelle tentative dans ${delaySeconds}s...`);
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(openTicketSocket, delaySeconds * 1000);
}

function openTicketSocket() {
  setConnectionStatus('Connexion...');
  socket = connectSocket(
    { ticketId: ticket.ticketId, accessToken: ticket.accessToken },
    {
      onOpen: () => {
        reconnectAttempts = 0;
        setConnectionStatus('');
      },
      onClose: (event) => {
        if (event.code === 4010) return; // déjà géré par onTicketDeleted
        if (event.code === 4001 || event.code === 4004) {
          showExpiredView();
          return;
        }
        scheduleReconnect();
      },
      onMessage: (data) => {
        try {
          const plaintext = decryptMessage(data.ciphertext, data.nonce, adminPublicKeyB64, keyPair.privateKey);
          addMessageToLog(plaintext, { fromMe: false, msgId: data.msgId });
        } catch {
          systemNote('Message reçu illisible (altéré).');
        }
      },
      onExpired: (data) => markExpired(data.msgId),
      onTicketDeleted: () => showExpiredView('Cette discussion a été supprimée par un admin.'),
    }
  );
}

// Toujours utilisée aussi bien pour créer un ticket que pour le rejoindre :
// comme la clé est dérivée du pseudo, cet appel resynchronise en continu la
// clé publique connue du serveur avec celle recalculée ici (auto-réparateur
// si le localStorage a disparu entre deux visites).
async function joinTicket(pseudo) {
  const keyRes = await fetch('/api/admin/public-key');
  if (!keyRes.ok) throw new Error('admin_not_configured');
  const { publicKey: fetchedAdminKey } = await keyRes.json();

  keyPair = deriveVisitorKeyPair(pseudo);
  const createRes = await fetch('/api/tickets', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pseudo, publicKey: toBase64(keyPair.publicKey) }),
  });
  const body = await createRes.json();
  if (!createRes.ok) throw new Error(body.error || 'unknown');

  adminPublicKeyB64 = fetchedAdminKey;
  ticket = {
    ticketId: body.ticketId,
    accessToken: body.accessToken,
    pseudo,
    createdAt: body.createdAt,
    expiresAt: body.expiresAt,
  };
  saveTicket({ ...ticket, adminPublicKey: adminPublicKeyB64 });
  return Boolean(body.resumed);
}

async function handleCreate(evt) {
  evt.preventDefault();
  const pseudo = $('#pseudo-input').value.trim();
  if (!pseudo) return;

  const submitBtn = $('#create-submit');
  submitBtn.disabled = true;
  submitBtn.textContent = 'Connexion...';
  $('#create-error').textContent = '';

  try {
    const resumed = await joinTicket(pseudo);
    openTicketView();
    if (resumed) systemNote('Discussion reprise.');
  } catch (err) {
    $('#create-error').textContent = translateError(err.message);
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Entrer';
  }
}

function handleSend(evt) {
  evt.preventDefault();
  const input = $('#message-input');
  const text = input.value.trim();
  if (!text) return;

  if (!socket || socket.raw.readyState !== WebSocket.OPEN) {
    setConnectionStatus('Pas encore connecté, réessaie dans un instant...');
    return;
  }

  const { ciphertext, nonce } = encryptMessage(text, adminPublicKeyB64, keyPair.privateKey);
  socket.sendMessage({ ciphertext, nonce });

  addMessageToLog(text, { fromMe: true });
  input.value = '';
}

function openTicketView() {
  show('ticket-view');
  $('#ticket-pseudo').textContent = ticket.pseudo;
  updateExpiryNote();
  clearInterval(expiryInterval);
  expiryInterval = setInterval(updateExpiryNote, 30000);
  openTicketSocket();
}

function translateError(code) {
  const map = {
    invalid_pseudo: '3 à 24 caractères, lettres/chiffres/-/_ uniquement.',
    pseudo_taken: 'Ce pseudo est déjà utilisé, choisis-en un autre.',
    invalid_public_key: 'Erreur de clé, recharge la page.',
    admin_not_configured: "Le service n'est pas encore configuré.",
  };
  return map[code] || 'Une erreur est survenue.';
}

async function resumeStoredTicket(stored) {
  if (stored.expiresAt <= Date.now()) {
    showExpiredView();
    return;
  }

  try {
    await joinTicket(stored.pseudo);
  } catch {
    // Resynchronisation impossible (hors-ligne, serveur momentanément
    // injoignable...) : on retente quand même avec les infos en cache
    // plutôt que de bloquer l'utilisateur sur une erreur.
    keyPair = deriveVisitorKeyPair(stored.pseudo);
    adminPublicKeyB64 = stored.adminPublicKey;
    ticket = {
      ticketId: stored.ticketId,
      accessToken: stored.accessToken,
      pseudo: stored.pseudo,
      createdAt: stored.createdAt,
      expiresAt: stored.expiresAt,
    };
  }

  openTicketView();
}

async function main() {
  await initCrypto();
  $('#create-form').addEventListener('submit', handleCreate);
  $('#send-form').addEventListener('submit', handleSend);
  $('#restart-button').addEventListener('click', () => show('create-view'));

  const stored = loadStoredTicket();
  if (stored) {
    await resumeStoredTicket(stored);
  } else {
    show('create-view');
  }
}

main();
