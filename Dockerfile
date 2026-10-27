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

# No build args. The Discord application id used to be compiled into the
# client bundle here; the server now injects it per request, so the image is
# the same whoever builds it and whoever runs it.
RUN npm run build -w packages/client && \
    npm run build -w packages/server

# ---------------------------------------------------------------------------
# Stage 3 — Production image
# ---------------------------------------------------------------------------
# Debian rather than Alpine, for ffmpeg. Jellyfin's build of it (Intel QSV and
# VAAPI with its own media driver, OpenCL tone mapping, Dolby Vision) and
# Intel's OpenCL runtime are built against glibc — 2.38 or newer, which is
# trixie. Nothing runs ffmpeg unless PLAYBACK_ENGINE=ffmpeg; with the Plex
# engine it is only files on disk.
FROM node:24-trixie-slim
WORKDIR /app

# jellyfin-ffmpeg, pinned and checked. The deb, not Jellyfin's apt repository,
# so the image doesn't trust another signing key.
ARG JELLYFIN_FFMPEG_VER=8.1.3-1
ARG JELLYFIN_FFMPEG_SHA256=fbef9f81a53e175194e3f67832618a86111f7bd37197df21a5d748c34289f9c0
# Intel's OpenCL runtime, which tone mapping on an Intel GPU runs on: the same
# versions Jellyfin's own image ships (jellyfin-packaging docker/Dockerfile).
ARG GMMLIB_VER=22.10.0
ARG GMMLIB_SHA256=6031a63d6e8a12ce61c14efc15f2c8e727061286e3820b8594e6d00615e04d54
ARG IGC2_VER=2.41.5
ARG IGC2_BUILD=22716
ARG IGC2_CORE_SHA256=0a6e64a663ae65a0fa02d6912ae3b6b37cf85b90c21cc423fd9fef70aaf4f628
ARG IGC2_OPENCL_SHA256=779e1b9e88098eb25711e9a8f67c2752665bad22f134aa40ed5649f6e1b87058
ARG NEO_VER=26.35.39758.10
ARG NEO_SHA256=61712caaddeba3d38e4f79e2a0fb23fea25596ca2d72c3144c6eea2331ec4301
# The app user keeps the numbers it had in the Alpine image, so a data folder
# bind-mounted from the host doesn't change owner on the way over.
ARG APP_UID=100
ARG APP_GID=101

# Debian security patches published since the base image was cut, then tini
# (PID 1 signal handling), clinfo (whether OpenCL sees the GPU, for
# scripts/diagnose-ffmpeg.mjs), a font for libass to draw a text subtitle
# burned in with (an ASS track's own fonts come out of the film), ffmpeg and
# the OpenCL runtime. curl fetches those and goes: the healthcheck asks with
# node, and curl and libcurl were 32 of the scan's findings on 24 October,
# four of them critical.
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get install -y --no-install-recommends ca-certificates curl tini clinfo fonts-dejavu-core fontconfig; \
    mkdir /tmp/debs; \
    cd /tmp/debs; \
    curl -fsSLo jellyfin-ffmpeg8.deb "https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v${JELLYFIN_FFMPEG_VER}/jellyfin-ffmpeg8_${JELLYFIN_FFMPEG_VER}-trixie_amd64.deb"; \
    curl -fsSLo libigdgmm12.deb "https://github.com/intel/compute-runtime/releases/download/${NEO_VER}/libigdgmm12_${GMMLIB_VER}_amd64.deb"; \
    curl -fsSLo intel-igc-core-2.deb "https://github.com/intel/intel-graphics-compiler/releases/download/v${IGC2_VER}/intel-igc-core-2_${IGC2_VER}+${IGC2_BUILD}_amd64.deb"; \
    curl -fsSLo intel-igc-opencl-2.deb "https://github.com/intel/intel-graphics-compiler/releases/download/v${IGC2_VER}/intel-igc-opencl-2_${IGC2_VER}+${IGC2_BUILD}_amd64.deb"; \
    curl -fsSLo intel-opencl-icd.deb "https://github.com/intel/compute-runtime/releases/download/${NEO_VER}/intel-opencl-icd_${NEO_VER}-0_amd64.deb"; \
    printf '%s  %s\n' \
      "$JELLYFIN_FFMPEG_SHA256" jellyfin-ffmpeg8.deb \
      "$GMMLIB_SHA256" libigdgmm12.deb \
      "$IGC2_CORE_SHA256" intel-igc-core-2.deb \
      "$IGC2_OPENCL_SHA256" intel-igc-opencl-2.deb \
      "$NEO_SHA256" intel-opencl-icd.deb \
      | sha256sum -c -; \
    apt-get install -y --no-install-recommends ./*.deb; \
    cd /; \
    rm -rf /tmp/debs; \
    apt-get purge -y --auto-remove curl; \
    for tool in ffmpeg ffprobe vainfo; do ln -s "/usr/lib/jellyfin-ffmpeg/$tool" "/usr/local/bin/$tool"; done; \
    ffmpeg -hide_banner -version | head -n 1; \
    setpriv --version; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Non-root user
RUN groupadd --system --gid "$APP_GID" appgroup && \
    useradd --system --uid "$APP_UID" --gid appgroup --home-dir /data --no-create-home --shell /usr/sbin/nologin appuser

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
RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends python3 make g++; \
    npm ci --omit=dev; \
    apt-get purge -y --auto-remove python3 make g++; \
    rm -rf /var/lib/apt/lists/*; \
    npm cache clean --force; \
    rm -rf /usr/local/lib/node_modules/npm \
           /usr/local/bin/npm /usr/local/bin/npx \
           /root/.npm /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Copy built artifacts
COPY --from=build /app/packages/server/dist packages/server/dist
COPY --from=build /app/packages/client/dist packages/client/dist
# Run with `docker exec <container> node scripts/<name>.mjs`.
COPY scripts/diagnose-ffmpeg.mjs scripts/library-survey.mjs scripts/

# Debian's security fixes again, in a layer each new build of the app makes
# afresh: the one at the top is cached from build to build, and the scan of
# 24 October found libbrotli1 a fix behind.
RUN set -eux; \
    export DEBIAN_FRONTEND=noninteractive; \
    apt-get update; \
    apt-get upgrade -y; \
    apt-get clean; \
    rm -rf /var/lib/apt/lists/*

# Persistent data directory (thumb cache SQLite) — mountable via THUMB_CACHE_DIR
RUN mkdir -p /data

# Entrypoint: take ownership of /data, join the GPU's group if one is mapped
# in, then drop to appuser — see docker/entrypoint.sh.
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

ENV NODE_ENV=production
ENV PORT=3000
# Intel's OpenCL runtime keeps the kernels it compiles here, so tone mapping
# doesn't compile them again on every start.
ENV XDG_CACHE_HOME=/data/.cache
EXPOSE ${PORT}

# Health check — /api/health probes Plex (cached server-side), so the container
# goes unhealthy when the thing it proxies is unreachable. `/` was answered off
# disk by express.static and stayed green through a total Plex outage.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD ["node", "-e", "fetch(`http://localhost:${process.env.PORT}/api/health`).then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]

ENTRYPOINT ["tini", "--", "entrypoint.sh"]
CMD ["node", "packages/server/dist/index.js"]
