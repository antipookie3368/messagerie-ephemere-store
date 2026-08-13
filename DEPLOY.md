# Déploiement sur ton serveur (Runtipi)

Confirmé : tu utilises **Nginx Proxy Manager** (app installée depuis l'app
store Runtipi) comme reverse proxy, pas Nginx manuel, pas le Traefik interne
de Runtipi directement. Toutes les instructions ci-dessous en tiennent compte.

## 0. Prérequis

- DNS : crée un enregistrement **A** pour `msg.hackhome.online` pointant vers
  l'IP publique de ta connexion (ou un CNAME si tu utilises déjà un DDNS).
- Box/routeur : le port **443** (et 80 pour la validation Let's Encrypt) doit
  être redirigé (NAT) vers ton serveur, là où Nginx Proxy Manager écoute.

## 1. Transférer le projet sur le serveur

Depuis MobaXterm, transfère tout le dossier `messagerie-ephemere/` (SFTP,
panneau de gauche) vers ton serveur, par exemple dans `~/apps/messagerie-ephemere`.

## 2. Créer le repo GitHub pour l'app store personnalisé

Runtipi exige un **repo git public** pour ajouter un app store custom (pas de
dossier local possible). Rien de sensible dedans (pas de clé, pas de mot de
passe), donc pas de souci à le rendre public.

Sur ta machine, dans `messagerie-ephemere/` :

```bash
git init
git add .
git commit -m "init app store messagerie ephemere"
```

Crée un nouveau repo public sur GitHub (ex: `messagerie-ephemere-store`), puis :

```bash
git remote add origin https://github.com/<ton-user>/messagerie-ephemere-store.git
git branch -M main
git push -u origin main
```

## 3. Builder l'image Docker sur le serveur

Connecte-toi en SSH sur ton serveur (MobaXterm), dans le dossier transféré :

```bash
cd ~/apps/messagerie-ephemere
docker build -t messagerie-ephemere-backend:latest -f backend/Dockerfile .
```

Cette image reste locale au daemon Docker du serveur — pas besoin de la
pousser sur un registry, Runtipi (qui tourne sur la même machine) la trouvera
directement par son tag.

> Après chaque modification du code, il faudra relancer cette commande de
> build puis redémarrer l'app depuis l'interface Runtipi.

## 4. Ajouter le store personnalisé dans Runtipi

Dans l'interface Runtipi :

1. **Settings → App Stores → Add App Store**
2. Colle l'URL : `https://github.com/<ton-user>/messagerie-ephemere-store`
3. Donne-lui un nom (ex: "Mes apps")
4. **Update App Stores**

L'app **"Messagerie Ephemere"** doit apparaître dans le catalogue. Installe-la
puis démarre-la (bouton Start).

## 5. Config du Proxy Host dans Nginx Proxy Manager

Une fois l'app démarrée, on doit trouver le nom réel du conteneur/service
pour le renseigner dans NPM. Lance ces deux commandes sur le serveur et
donne-moi le résultat, je te donnerai les valeurs exactes à mettre dans NPM
(domaine, forward hostname/port, activation WebSockets, SSL) :

```bash
docker ps --filter "name=messagerie" --format "table {{.Names}}\t{{.Ports}}\t{{.Networks}}"
docker network ls
```

## Rappel sécurité

- Toutes les clés privées restent en mémoire navigateur, jamais persistées.
- Le serveur ne stocke que des blobs chiffrés + métadonnées minimales (TTL,
  id de salon), jamais de texte en clair, jamais de logs de contenu.
- Limite connue du MVP : pas de vérification d'empreinte de clé (protection
  anti-MITM manuelle façon Signal) — prévue dans une itération suivante.
