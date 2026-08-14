# Build context = racine du projet (voir docker-compose.yml: build.context: .)

# Stage 1 : vendorer libsodium-wrappers pour le frontend (pas de CDN externe,
# tout est servi depuis notre propre serveur). On le bundle nous-mêmes avec
# esbuild plutôt que de dépendre d'un fichier "prêt à l'emploi" du package
# npm (les versions récentes ne publient plus dist/browsers/sodium.js).
FROM node:20-alpine AS frontend-vendor
WORKDIR /fe
COPY frontend/package.json ./
RUN npm install
COPY frontend/vendor-entry.js ./
RUN npx esbuild vendor-entry.js --bundle --format=iife --outfile=sodium.js

FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

COPY backend/src ./src
COPY frontend/src ./frontend/src
COPY --from=frontend-vendor /fe/sodium.js ./frontend/src/vendor/sodium.js

ENV NODE_ENV=production
ENV FRONTEND_DIR=/app/frontend/src
ENV PORT=3000

EXPOSE 3000

USER node

CMD ["node", "src/server.js"]
