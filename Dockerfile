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

# Pick up Alpine security patches published since the base image was cut. The
# scanner flags busybox/ssl_client and nghttp2-libs here, and neither is pinned
# by anything we install, so upgrading in place is the whole fix.
RUN apk upgrade --no-cache

# Tini for proper PID 1 signal handling; ffmpeg for HLS transcoding (we produce
# the video stream ourselves now rather than proxying Plex's transcoder); curl
# for the healthcheck.
#
# Subtitle fonts (see the backend-overhaul notes): libass needs fonts to draw
# burned-in subtitles. This set covers what subtitles ask for — Liberation
# (Arial/Times/Courier metric-compatible), DejaVu (Latin/Cyrillic/Greek), Noto +
# Noto CJK (Japanese/Chinese/Korean, i.e. anime) + Noto emoji. fc-cache prebuilds
# the cache so the first burn doesn't stall.
#
# VAAPI runtime for Intel QuickSync (HWACCEL=vaapi|qsv): libva is the API,
# intel-media-driver (iHD) is the driver for Gen8+ Intel, and libva-utils gives
# `vainfo` for diagnosing GPU access. They only matter when the host maps
# /dev/dri into the container; with HWACCEL=none they sit unused. For older Intel
# iGPUs (≤ Gen7) set LIBVA_DRIVER_NAME=i965 and add libva-intel-driver instead.
RUN apk add --no-cache tini curl ffmpeg fontconfig \
      font-liberation font-dejavu font-noto font-noto-cjk font-noto-emoji \
      libva libva-utils intel-media-driver \
    && fc-cache -f

# Non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

COPY package.json package-lock.json ./
COPY packages/server/package.json packages/server/

# Minimal client package.json so npm workspace resolves without client deps
RUN mkdir -p packages/client && \
    echo '{"name":"@plex-discord-theater/client","private":true}' > packages/client/package.json

# better-sqlite3 needs build tools for native addon.
#
# npm itself is then deleted. The container starts with `node …` and never
# shells out to npm, but npm ships its own vendored copies of tar, undici and
# brace-expansion — which is where the scanner's node-tar gzip-bomb CVE and the
# undici advisories come from. None of it is reachable by the running app, and
# removing the tool removes the finding rather than arguing about reachability.
RUN apk add --no-cache python3 make g++ && \
    npm ci --omit=dev && \
    apk del python3 make g++ && \
    npm cache clean --force && \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm /usr/local/bin/npx \
           /root/.npm /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

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
# Per-session HLS segments live here — under /data so they land on the same
# volume the entrypoint chowns to appuser (and can be a tmpfs mount for speed).
ENV HLS_TMP_DIR=/data/hls
EXPOSE ${PORT}

# Health check — /api/health probes Plex (cached server-side), so the container
# goes unhealthy when the thing it proxies is unreachable. `/` was answered off
# disk by express.static and stayed green through a total Plex outage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD curl -fsS http://localhost:${PORT}/api/health || exit 1

ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
