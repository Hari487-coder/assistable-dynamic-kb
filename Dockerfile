# Live KB — zero native deps (Node built-in SQLite), so this stays tiny.
FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src
ENV NODE_ENV=production DATA_DIR=/data SIGNUPS=first-only MOCK_ASSISTABLE=0 PORT=3900
VOLUME /data
EXPOSE 3900
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:3900/healthz || exit 1
CMD ["node", "src/server.js"]
