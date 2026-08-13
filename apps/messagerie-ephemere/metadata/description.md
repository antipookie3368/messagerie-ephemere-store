# Messagerie éphémère E2EE

Messagerie de bout en bout chiffrée (libsodium/crypto_box). Le serveur ne
voit jamais de texte en clair : il relaie et stocke uniquement des blobs
chiffrés par les clients, avec deux modes de suppression au choix pour
chaque message :

- **À la lecture** : détruit dès que le destinataire l'a déchiffré.
- **Après délai** : détruit automatiquement via l'expiration native Redis.

Comptes légers par pseudonyme, sans email ni donnée personnelle.
