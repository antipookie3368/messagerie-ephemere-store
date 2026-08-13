# Architecture — Messagerie éphémère E2EE (MVP)

Domaine : `msg.hackhome.online` (confirmé)

## Principe de base

Le serveur ne voit **jamais** de texte en clair. Il relaie et stocke uniquement
des blobs chiffrés (ciphertext + nonce), des clés publiques, et des métadonnées
minimales (id de salon, horodatage d'expiration). Toute la cryptographie
(génération de clés, chiffrement, déchiffrement) se fait côté client avec
libsodium.js (crypto_box : X25519 + XSalsa20-Poly1305).

## Acteurs

- **Client A / Client B** : navigateurs, exécutent libsodium.js
- **Serveur** : Node.js/Fastify + WebSocket, aucune logique crypto
- **Redis** : stockage des messages chiffrés (TTL natif) + métadonnées de salon

## Flux 1 — Création de compte léger

```
Client                          Serveur                    Redis
  |--- POST /api/register ------->|
  |    { pseudo }                 |
  |                                |--- SET user:<pseudo> --->|
  |                                |    { createdAt }         |
  |<--- { sessionToken } ----------|                          |
```

- Pas d'email, pas de mot de passe. Le pseudo doit être unique par instance.
- `sessionToken` = identifiant opaque signé (JWT léger ou token aléatoire +
  entrée Redis), sert uniquement à authentifier la connexion WebSocket.
- Rate limiting sur `/api/register` (par IP) pour éviter le spam de comptes.

## Flux 2 — Création de salon et échange de clés publiques

```
Client A                        Serveur                    Client B
  |-- génère keypair (sk_A, pk_A) localement (jamais envoyée sk_A)
  |
  |--- POST /api/room ------------>|
  |    { pk_A, expireMode }        |
  |                                |--- SET room:<id> -------->|
  |<--- { roomId, joinLink } -------|   { pk_A, expireMode }
  |
  |  (partage joinLink hors bande : lien, QR code...)
  |
                                    |<--- GET /api/room/:id ----|
                                    |---- { pk_A, expireMode } ->|
                                                              |-- génère keypair (sk_B, pk_B)
                                    |<--- POST pk_B ------------|
                                    |--- SET room:<id>.pk_B --->|
  |<--- notif WS: pk_B reçue -------|
```

- Le serveur ne fait que stocker/relayer `pk_A` et `pk_B`. Il n'a aucun moyen
  de calculer le secret partagé (nécessite `sk_A` ou `sk_B`, jamais transmises).
- Risque MITM assumé au niveau du MVP : le serveur pourrait en théorie
  substituer une clé publique. Amélioration future : empreinte de clé
  affichée aux deux utilisateurs pour vérification manuelle (comme Signal).

## Flux 3 — Envoi / réception d'un message

```
Client A                        Serveur (WS)                Client B
  |-- chiffre(message, sk_A, pk_B) => { ciphertext, nonce }
  |
  |--- WS send: { roomId, ciphertext, nonce, mode, ttl } -->|
  |                                |--- SETEX msg:<id> ttl ->| Redis
  |                                |    { ciphertext, nonce } |
  |                                |--- WS push vers B ------>|
  |                                                            |-- déchiffre(ciphertext, sk_B, pk_A)
  |                                                            |-- affiche le message
  |                                                            |
  |                                |<-- WS: ACK lecture -------|  (si mode = "lecture")
  |                                |--- DEL msg:<id> --------->|
  |<--- WS: confirmation purge ----|
```

- **Mode délai** : `SETEX msg:<id> <ttl_secondes> <payload>` — Redis purge
  automatiquement, pas d'intervention serveur nécessaire.
- **Mode lecture** : le message reste en `SET` (sans TTL, ou TTL de sécurité
  long en filet de sécurité) jusqu'à l'ACK de lecture du destinataire, qui
  déclenche un `DEL` immédiat côté serveur.
- Si le destinataire n'est pas connecté au moment de l'envoi, le message
  attend dans Redis (borné par son TTL) jusqu'à sa connexion.

## Flux 4 — Expiration

```
Redis (clé expirée) --keyspace notification--> Serveur --> WS push "message expiré" --> Clients
```

- Activer `notify-keyspace-events Ex` dans Redis pour être notifié des
  expirations et informer les clients connectés (pour que l'UI retire le
  message même si personne ne l'a lu).

## Arborescence du projet

```
messagerie-ephemere/
├── ARCHITECTURE.md
├── docker-compose.yml
├── config.json                  # métadonnées app custom Runtipi
├── nginx/
│   └── msg.hackhome.online.conf
├── backend/
│   ├── Dockerfile
│   ├── package.json
│   └── src/
│       ├── server.js            # bootstrap Fastify + WS
│       ├── routes/
│       │   ├── register.js
│       │   └── room.js
│       ├── ws/
│       │   └── handler.js       # relais des messages chiffrés
│       ├── redis.js
│       └── rateLimit.js
└── frontend/
    ├── Dockerfile (nginx statique) OU servi par le backend en statique
    └── src/
        ├── index.html
        ├── crypto.js             # wrapper libsodium (keygen, encrypt, decrypt)
        ├── ws-client.js
        ├── app.js
        └── style.css
```

## Ce qui n'est PAS dans le MVP (étapes suivantes)

- Rôle admin (permissions à définir)
- Rate limiting avancé / captcha
- Vérification manuelle d'empreinte de clé (anti-MITM)
- Mode "délai" (arrive en étape 2, la structure Redis le supporte déjà)
