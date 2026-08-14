// Wrapper autour de libsodium (vendored dans vendor/sodium.js, chargé en
// balise <script> classique qui expose un global `sodium`).
// Toute la crypto tourne ici, côté client. Rien de ceci n'est jamais
// envoyé au serveur en clair.

let ready = false;

export async function initCrypto() {
  if (ready) return;
  await sodium.ready;
  ready = true;
}

export function generateKeyPair() {
  const kp = sodium.crypto_box_keypair();
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

// Paire de clés déterministe pour un visiteur : retaper le même pseudo
// recalcule exactement la même clé, sans dépendre du localStorage (qui peut
// disparaître : fermeture d'onglet privé, nettoyage navigateur...).
// Conséquence assumée : connaître le pseudo suffit à déchiffrer toute la
// conversation, passée et future — pas seulement à la rejoindre.
export function deriveVisitorKeyPair(pseudo) {
  const seed = sodium.crypto_generichash(
    sodium.crypto_box_SEEDBYTES,
    sodium.from_string(`ephemr-visitor:${pseudo.toLowerCase()}`)
  );
  const kp = sodium.crypto_box_seed_keypair(seed);
  return { publicKey: kp.publicKey, privateKey: kp.privateKey };
}

export function toBase64(bytes) {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

export function fromBase64(str) {
  return sodium.from_base64(str, sodium.base64_variants.URLSAFE_NO_PADDING);
}

// Chiffre `plaintext` (string) pour `recipientPublicKey`, avec ma clé privée.
// Retourne { ciphertext, nonce } encodés en base64, prêts pour le réseau.
export function encryptMessage(plaintext, recipientPublicKeyB64, myPrivateKey) {
  const recipientPublicKey = fromBase64(recipientPublicKeyB64);
  const nonce = sodium.randombytes_buf(sodium.crypto_box_NONCEBYTES);
  const message = sodium.from_string(plaintext);
  const ciphertext = sodium.crypto_box_easy(message, nonce, recipientPublicKey, myPrivateKey);
  return {
    ciphertext: toBase64(ciphertext),
    nonce: toBase64(nonce),
  };
}

// Déchiffre un message reçu. Lève une exception si l'authentification
// (Poly1305) échoue, ce qui signale une altération ou une mauvaise clé.
export function decryptMessage(ciphertextB64, nonceB64, senderPublicKeyB64, myPrivateKey) {
  const ciphertext = fromBase64(ciphertextB64);
  const nonce = fromBase64(nonceB64);
  const senderPublicKey = fromBase64(senderPublicKeyB64);
  const plaintextBytes = sodium.crypto_box_open_easy(ciphertext, nonce, senderPublicKey, myPrivateKey);
  return sodium.to_string(plaintextBytes);
}

// Enveloppe une clé privée admin avec un secret dérivé du mot de passe
// (Argon2id via crypto_pwhash), pour pouvoir la recouvrer sur n'importe quel
// appareil sans export/import manuel. Le serveur ne stocke que ce blob
// chiffré + le sel : il ne peut pas dériver la clé sans le mot de passe.
export function wrapPrivateKeyWithPassword(privateKey, password) {
  const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
  const derivedKey = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_DEFAULT
  );
  const nonce = sodium.randombytes_buf(sodium.crypto_secretbox_NONCEBYTES);
  const encrypted = sodium.crypto_secretbox_easy(privateKey, nonce, derivedKey);
  return {
    encryptedPrivateKey: toBase64(encrypted),
    nonce: toBase64(nonce),
    salt: toBase64(salt),
  };
}

// Lève une exception si le mot de passe ne correspond pas (authentification
// Poly1305 du secretbox), ce qui distingue clairement "mauvais mot de passe"
// d'une simple absence de sauvegarde.
export function unwrapPrivateKeyWithPassword(encryptedPrivateKeyB64, nonceB64, saltB64, password) {
  const salt = fromBase64(saltB64);
  const derivedKey = sodium.crypto_pwhash(
    sodium.crypto_secretbox_KEYBYTES,
    password,
    salt,
    sodium.crypto_pwhash_OPSLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_MEMLIMIT_INTERACTIVE,
    sodium.crypto_pwhash_ALG_DEFAULT
  );
  const nonce = fromBase64(nonceB64);
  const encrypted = fromBase64(encryptedPrivateKeyB64);
  return sodium.crypto_secretbox_open_easy(encrypted, nonce, derivedKey);
}
