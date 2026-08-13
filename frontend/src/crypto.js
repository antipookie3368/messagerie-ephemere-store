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
