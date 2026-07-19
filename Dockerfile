# Target platform — set via `docker buildx build --platform` or defaults to amd64
ARG TARGETPLATFORM=linux/amd64

# ---------------------------------------------------------------------------
# Stage 1 — Install dependencies (cached unless package files change)
# ---------------------------------------------------------------------------
FROM node:24-alpine AS deps
WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/
COPY packages/client/package.json packages/client/

# better-sqlite3 needs build tools for native compilation
RUN apk add --no-cache python3 make g++ && \
    npm ci && \
    apk del python3 make g++

# ---------------------------------------------------------------------------
# Stage 2 — Build client and server
# ---------------------------------------------------------------------------
FROM node:24-alpine AS build
WORKDIR /app

COPY --from=deps /app/ .

COPY tsconfig.base.json ./
COPY packages/client/ packages/client/
COPY packages/server/ packages/server/

# Vite needs the Discord client ID at build time
ARG VITE_DISCORD_CLIENT_ID
ENV VITE_DISCORD_CLIENT_ID=$VITE_DISCORD_CLIENT_ID

RUN npm run build -w packages/client && \
    npm run build -w packages/server

# ---------------------------------------------------------------------------
# Stage 3 — Production image (minimal)
# ---------------------------------------------------------------------------
FROM node:24-alpine
WORKDIR /app

# Tini for proper PID 1 signal handling
RUN apk add --no-cache tini curl

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/

# Minimal client package.json so npm workspace resolves without client deps
RUN mkdir -p packages/client && \
    echo '{"name":"@plex-discord-theater/client","private":true}' > packages/client/package.json

# better-sqlite3 needs build tools for native addon
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    apk del python3 make g++ && \
    npm cache clean --force

# Copy built artifacts
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/client/dist packages/client/dist

# Persistent data directory (thumb cache SQLite) — mountable via THUMB_CACHE_DIR
RUN mkdir -p /data

# Entrypoint script: fix /data ownership then drop to appuser
RUN printf '#!/bin/sh\nchown -R appuser:appgroup /data\nexec su-exec appuser "$@"\n' > /usr/local/bin/entrypoint.sh && \
    chmod +x /usr/local/bin/entrypoint.sh
RUN apk add --no-cache su-exec

ENV NODE_ENV=production
ENV PORT=3000
EXPOSE ${PORT}

# Health check — hit a lightweight endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:${PORT}/ || exit 1

ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
