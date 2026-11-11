# Installation

On this page you deploy the server with Docker Compose and check that it
works. Have these ready first:

| Value | From |
|---|---|
| `DISCORD_CLIENT_ID` and `DISCORD_CLIENT_SECRET` | [Discord Application Setup](Discord-Application-Setup) |
| `PLEX_URL` and `PLEX_TOKEN`, and ideally `PLEX_ACCOUNT_TOKEN` | [Plex Setup](Plex-Setup) |
| Your public HTTPS address | [HTTPS and Reverse Proxy](HTTPS-and-Reverse-Proxy) |

Most people should [install the published image](#install-the-published-image).
[Build from source](#build-from-source) if you want to change the code.

## Install the published image

### 1. Create the compose file

Create a folder for the stack and a `docker-compose.yml` in it, or paste this
into Portainer, Dockge or Dockhand as a new stack.

```yaml
services:
  plex-discord-theater:
    image: ghcr.io/monkeygonewild/plex-discord-theater:latest
    container_name: plex-discord-theater
    restart: unless-stopped
    ports:
      - "3000:3000"
    volumes:
      - app-data:/data
    environment:
      # Required
      DISCORD_CLIENT_ID: ""
      DISCORD_CLIENT_SECRET: ""
      PLEX_URL: "http://192.168.1.50:32400"
      PLEX_TOKEN: ""
      REDIRECT_URI: "https://watch.example.com"
      ALLOWED_ORIGINS: "https://watch.example.com"

      # Recommended
      # PLEX_ACCOUNT_TOKEN: ""
      # TMDB_API_KEY: ""

      # Streaming defaults. Change them only if you want to.
      VIDEO_BITRATE_KBPS: "20000"
      VIDEO_PEAK_BITRATE_KBPS: "33000"
      DIRECT_STREAM_MAX_KBPS: "25000"

      # Keeps the server's data on the volume above. Leave as it is.
      THUMB_CACHE_DIR: "/data"

volumes:
  app-data:
```

Every other setting is optional. They are all listed in the
[Configuration Reference](Configuration-Reference).

### 2. Fill in the required values

| Setting | Value |
|---|---|
| `DISCORD_CLIENT_ID` | The Application ID from the Developer Portal |
| `DISCORD_CLIENT_SECRET` | The Client Secret from the Developer Portal |
| `PLEX_URL` | Plex's address as the container reaches it. Never `localhost`, which is the container itself. |
| `PLEX_TOKEN` | The server owner's Plex token |
| `REDIRECT_URI` | Your public address, with `https://` and no trailing slash |
| `ALLOWED_ORIGINS` | The same address. For more than one, separate them with commas. |

`REDIRECT_URI` and `ALLOWED_ORIGINS` must match the host you mapped in the
Discord Developer Portal exactly.

> [!TIP]
> If you keep values in a `.env` file and one contains a `$` or a `#`, wrap it
> in single quotes: `ADMIN_PASSWORD='pa$$word#1'`. Docker Compose otherwise
> reads `$name` as a variable and changes the value.

### 3. Start it

```bash
docker compose up -d
```

In a stack manager, deploy the stack.

### Image tags

| Tag | Follows |
|---|---|
| `latest` | The newest release |
| A version, such as `2.2.0` | That release only |

## Build from source

```bash
git clone https://github.com/MonkeyGoneWIld/plex-discord-theater.git
cd plex-discord-theater
cp .env.example .env
```

Edit `.env` and set the six required values. Then build and start:

```bash
docker compose up -d --build
```

The repository's `docker-compose.yml` reads its settings from `.env`. The first
build takes several minutes.

## Check that it works

### 1. The container is healthy

```bash
docker compose ps
```

The status should become `healthy` within a minute. The health check asks Plex
for its identity, so `unhealthy` usually means `PLEX_URL` is wrong. See
[Troubleshooting](Troubleshooting#the-container-is-unhealthy-or-keeps-restarting).

### 2. The startup summary

```bash
docker compose logs plex-discord-theater | grep Config
```

```text
[Config] ✓ TMDB   ✓ TVDB   ✓ Requests   ✓ Discover   ✓ HEVC   ✓ Direct Stream for files averaging up to 25000 kbps   · Guild allowlist (open to any Discord server)
[Config] films being played: copied ones kept until the stream ends, 6144 MB in memory (DIRECT_STREAM_MEMORY_MB) and the rest on disk at /data/stream-cache (STREAM_CACHE_DIR); re-encoded ones 2048 MB in memory (TRANSCODE_CACHE_MB), the rest on Plex's disk
[Config] playback engine: Plex
```

| Line | What it tells you |
|---|---|
| First | Which features are on (`✓`) or off (`·`). The optional ones are in [Optional Integrations](Optional-Integrations). |
| Second | How much memory and disk the films being played may use. See [Stream caches](Configuration-Reference#stream-caches). |
| Third | Which engine makes the streams: Plex, or the [FFmpeg engine](FFmpeg-Engine) |

### 3. The public address

Open `https://watch.example.com/api/health` in a browser, with your own
address. This reply means the address reaches the server and the server
reaches Plex:

```json
{"status":"ok","plex":"reachable","uptimeS":42}
```

If the page doesn't load, check the tunnel or proxy in
[HTTPS and Reverse Proxy](HTTPS-and-Reverse-Proxy).

## Where your data is kept

Everything the server stores is in the `app-data` volume, mounted at `/data`:
sign-in sessions, watch history, linked Plex accounts, cached artwork and
details, logs, and the films being played. Keep the volume when you update.
See [Updating and Backups](Updating-and-Backups).

## Optional extras

| Extra | What it adds | Page |
|---|---|---|
| The dashboard | A page for you, on its own port, showing what is playing and why | [Dashboard](Dashboard) |
| The FFmpeg engine | Streams made in the container, on your GPU | [FFmpeg Engine](FFmpeg-Engine) |
| Seerr, TMDB and TVDB | Requests and richer title pages | [Optional Integrations](Optional-Integrations) |
| plex-qbt-manager | Lower qBittorrent upload while people watch | [qBittorrent Manager API](qBittorrent-Manager-API) |

## Next

→ [First Launch](First-Launch)
