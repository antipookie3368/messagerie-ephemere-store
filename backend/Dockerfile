# Build context = racine du projet (voir docker-compose.yml: build.context: .)
FROM node:20-alpine

WORKDIR /app

COPY backend/package.json backend/package-lock.json* ./
RUN npm install --omit=dev

COPY backend/src ./src
COPY frontend/src ./frontend/src

ENV NODE_ENV=production
ENV FRONTEND_DIR=/app/frontend/src
ENV PORT=3000

EXPOSE 3000

USER node

CMD ["node", "src/server.js"]
