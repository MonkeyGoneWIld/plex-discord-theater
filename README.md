# Plex Discord Theater

A Discord Activity that lets you browse your Plex library and watch movies and TV shows together in a voice channel — synchronized playback, host controls, and all streamed through Discord.

## Features

- **Browse your Plex library** — movies and TV shows with search, genre filters, and sorting
- **Discover titles beyond your library** — search also surfaces movies and shows you don't own (marked "Not in library" and non-playable), with full detail pages
- **Request what's missing** — optional [Seerr](#requesting-titles-optional) (Overseerr / Jellyseerr) integration adds a Request button for movies and per-season TV requests, attributed to your own Seerr account
- **Synchronized playback** — the host controls play/pause/seek and all viewers stay in sync
- **Co-hosts & host transfer** — the host can grant transport control (play/pause/seek/subtitles) to others, or hand over the host role entirely, from a people panel
- **Audio & subtitle selection** — switch tracks before playing or mid-episode; co-hosts can change subtitles
- **Skip Intro / Skip Credits** — uses Plex's chapter markers, when the library has them
- **Next & previous episode** — resolved automatically from the series (including season rollover), with a card at the end of an episode
- **Queue & viewer suggestions** — the host can queue what's next, and viewers can suggest titles
- **Playback status for viewers** — a badge shows when the host has paused or is seeking, so viewers know why playback stalled
- **Seek-bar thumbnail previews** — hover the progress bar to preview that moment, when Plex has generated preview thumbnails
- **Volume memory** — starts at 50% and remembers your level across sessions
- **Stats for nerds** — press `i` for resolution, codecs, bitrate, buffer health, and P2P counters
- **VPS relay** — optional nginx caching proxy offloads segment delivery to a VPS with 1 Gbps, so your home upload isn't the bottleneck
- **Segment pre-fetching** — server proactively fetches segments from Plex ahead of playback, eliminating throttle-related buffering at cold start
- **P2P segment sharing** — when no VPS is configured, viewers can share HLS segments with each other via WebRTC
- **Automatic host promotion** — if the host leaves, a co-host is promoted where there is one, otherwise another viewer, so the session continues
- **Thumbnail caching** — artwork is cached server-side in SQLite for fast browsing
- **Persistent sessions** — sessions and host roles survive server restarts (SQLite-backed)
- **Secure** — your Plex token never leaves the server; the backend proxies everything

> **Two features depend on Plex-side generation**, both off by default on many servers, and both silently do nothing without it:
> Skip Intro/Credits needs *Detect intros and credits*, and seek-bar previews need *Generate video preview thumbnails* — each under Library → Edit → Advanced.

## How It Works

```
Discord Voice Channel
  └─ Activity (iframe)
       └─ React client (hls.js)
            ├─ VPS relay (nginx cache) — when configured
            ├─ OR: WebRTC ↔ other viewers (P2P segment sharing) — fallback
            └─ Express backend (WebSocket sync + API proxy + segment pre-fetch cache)
                 └─ Plex Media Server (HLS transcoding)
```

The first user to join becomes the host and can browse the library and start playback. Everyone else watches in sync via WebSocket. The backend proxies all Plex API calls and HLS video segments so nothing is exposed directly to clients.

### VPS Relay (Recommended)

When `VPS_RELAY_URL` is configured, HLS segments are served through a VPS with nginx caching instead of directly from your home server. Your Plex server transcodes once and uploads one stream to the VPS — the VPS then fans it out to all viewers from its 1 Gbps connection.

```
Without VPS:  Home upload = N viewers × bitrate (bottleneck)
With VPS:     Home upload = 1 stream to VPS (~8-12 Mbps), VPS handles the rest
```

This is the recommended setup for watch parties with more than a few viewers. P2P is automatically disabled when VPS relay is active. See [VPS Relay Setup](#vps-relay-optional) below and [docs/vps-relay-setup.md](docs/vps-relay-setup.md) for the full guide.

### Segment Pre-Fetching

The server proactively fetches HLS segments from Plex into an in-memory cache before viewers request them. This eliminates the ~30-second throttle gap that Plex imposes on HTTP segment delivery at the start of a new transcode session.

How it works:
- After starting a transcode, the server polls the HLS sub-manifest every 2 seconds to discover available segments
- 3 concurrent workers fetch discovered segments from Plex and cache them in memory
- After a seek, fetching is ordered from the seek target forward (not from the start), so the segments actually being played are warmed first
- When the VPS (or a viewer) requests a segment, Express serves it instantly from cache
- Cache miss falls through to on-demand Plex fetch (existing behavior)
- Supports up to 2 concurrent watch party sessions
- Memory-bounded: max 100 segments per session (~450 MB at the default 12 Mbps), with eviction prioritizing already-served segments

Combined with timeline updates (which tell Plex the client's playback position), this ensures smooth playback from the very first second.

### P2P Segment Sharing (Fallback)

When no VPS is configured, viewers in the same watch session automatically form a peer-to-peer mesh using WebRTC. When one viewer downloads an HLS segment from the server, they share it directly with other viewers — so the same segment doesn't need to be fetched from Plex multiple times.

- **BitTorrent tracker** — the server runs an embedded [bittorrent-tracker](https://github.com/webtorrent/bittorrent-tracker) over WebSocket for peer discovery and signaling
- **Swarm per session** — viewers watching the same content share a swarm ID, so P2P only happens within a watch session
- **Transparent fallback** — if a segment isn't available from peers in time, it falls back to fetching from the server normally
- **Window tuning** — all three loader windows (high-demand, P2P, HTTP) are set to 120s to match the client's forward buffer, with 2 concurrent HTTP downloads
- **NAT traversal** — uses a STUN server for WebRTC connections behind NAT

**How much P2P actually carries.** Less than it used to. The loader fetches "high-demand" segments over HTTP in preference to P2P, and that window now spans the entire 120s buffer — so in practice most segments come from the server and peers contribute at the margins. That was a deliberate trade: before the windows were widened, a viewer with no peers could only ever buffer ~15 seconds ahead, because the high-demand window was the only thing driving HTTP fetches.

P2P still helps when several people watch together, but it is not the answer to upload bandwidth and is capped by your home connection either way. **For anything beyond a few viewers, use the VPS relay.**

### Transcode Configuration

The server requests HLS transcoding from Plex with these settings:

| Setting | Value | Reason |
|---------|-------|--------|
| Video codec | H.264 | Universal browser compatibility |
| Audio codec | AAC preferred, MP3 fallback | Plex direct-streams compatible audio; transcodes to MP3 for incompatible codecs like TrueHD |
| Max resolution | 1920×1080 | Good quality without excessive bandwidth |
| Target bitrate | 12 Mbps (peak 20 Mbps) | Balances quality and bandwidth — configurable via `VIDEO_BITRATE_KBPS` / `VIDEO_PEAK_BITRATE_KBPS` |
| Segment duration | 3 seconds | Faster cold start — Plex only needs to transcode 3s before the first segment is ready |
| Location | LAN | Treats the connection as local to avoid WAN throttling |
| Direct stream audio | Enabled | Passes through compatible audio (e.g. AAC) without re-encoding; transcodes incompatible codecs (e.g. TrueHD) |

### Requesting Titles (Optional)

Search surfaces Plex's online "Discover" catalog alongside your library, so results
include movies and shows you don't own — flagged **Not in library** and non-playable.
Opening one shows its detail page, and when a Seerr (Overseerr / Jellyseerr) instance
is configured, a **Request** button.

- Set `SEERR_URL` to enable it; left unset, the Request button is hidden.
- Requests are attributed to **your own Seerr account** — the server signs in with
  `PLEX_ACCOUNT_TOKEN` (`POST /auth/plex`), not an admin API key.
- Movies request in one click; TV shows offer **per-season** selection, showing which
  seasons you already have, which are already requested/processing, and which are
  available to request.

Because the Activity runs in a sandboxed cross-origin iframe, all Seerr calls go
through the server — it can't reuse your browser's Overseerr session.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Client | React, hls.js, [p2p-media-loader](https://github.com/nicedoc/p2p-media-loader), Discord Embedded App SDK |
| Server | Express, WebSocket (ws), bittorrent-tracker, better-sqlite3 |
| Streaming | HLS via Plex transcoder, server-side segment pre-fetch cache, WebRTC P2P sharing |
| Infrastructure | Docker, Node.js 24, optional nginx VPS relay |

## Prerequisites

- **Node.js 24+** (or Docker)
- **A Plex Media Server** accessible from the machine running the backend
- **A Discord application** with Activities enabled
- **A public HTTPS URL** pointing to the backend (for Discord's iframe proxy)

## Setup

### 1. Discord Developer Portal

1. Go to [discord.com/developers/applications](https://discord.com/developers/applications) and create a new application
2. Go to **Activities > Settings** and enable Activities
3. Add a URL mapping: `/` → your server's public URL
4. Copy your **Client ID** and **Client Secret**

### 2. Get Your Plex Token

Find your token by opening Plex Web, playing any media, then checking the Network tab in DevTools for `X-Plex-Token=` in query parameters. Or follow the [official Plex guide](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

### 3. Environment Variables

```bash
cp .env.example .env
```

Edit `.env` with your values:

```env
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
PLEX_URL=http://localhost:32400
PLEX_TOKEN=your_plex_token
PORT=3000
REDIRECT_URI=https://your-public-url.example.com
ALLOWED_ORIGINS=https://your-public-url.example.com

# Optional — plex.tv ACCOUNT token (not the server token above). Used for online
# "Discover" search detail lookups, and to sign in to Seerr. Without it, Discover
# results still appear but their detail pages have no description.
# PLEX_ACCOUNT_TOKEN=your_plex_account_token

# Optional — Seerr (Overseerr / Jellyseerr) URL, enables the Request button (see
# "Requesting Titles" below). Requests use your own Seerr account via the account
# token above — no API key needed.
# SEERR_URL=https://requests.yourdomain.com

# Optional — VPS relay (see "VPS Relay Setup" section below)
# VPS_RELAY_URL=https://theater.yourdomain.com
# VPS_RELAY_KEY=your-secret-key
```

For local development, also create `packages/client/.env`:

```env
VITE_DISCORD_CLIENT_ID=your_discord_client_id
```

### 4. Run

#### Docker (recommended)

```bash
docker compose up --build
```

#### Local Development

```bash
npm install
npm run dev
```

This starts both services concurrently:

| Service | URL | Description |
|---------|-----|-------------|
| Server  | `http://localhost:3000` | Express API + WebSocket |
| Client  | `http://localhost:5173` | Vite dev server (proxies `/api` to server) |

#### Tunnel for Discord

Discord Activities require a public HTTPS URL. For local dev, use [Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/):

```bash
brew install cloudflared
cloudflared tunnel --url http://localhost:5173
```

Set the resulting `https://xxxx.trycloudflare.com` URL as the URL mapping in your Discord app's Activities settings.

> **Note:** The tunnel URL changes every restart. Use a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/) for a stable URL.

### 5. Deploy

Build and push the Docker image:

```bash
npm run deploy
```

Then on your server (e.g. Unraid):

```bash
docker compose pull && docker compose up -d
```

### 6. Launch

1. Join a voice channel in Discord
2. Click the **Activities** (rocket) icon
3. Select your app — the Activity loads and you'll see the Plex library

## VPS Relay (Optional)

Route HLS segments through a VPS (~$7/mo) to offload upload bandwidth from your home server during watch parties. Your home uploads one stream to the VPS; the VPS fans it out to all viewers from its 1 Gbps connection.

### Why

If your home upload is 100 Mb/s and you're running a watch party with 10 viewers at 8 Mbps, that's 80 Mb/s — leaving almost nothing for other Plex users. With the VPS relay, home upload drops to ~8 Mb/s regardless of viewer count.

### Quick Setup Overview

1. **Create a Hetzner VPS** (CAX11 or CX23) at [hetzner.com/cloud](https://www.hetzner.com/cloud) — Primary IPv4, Ubuntu 24.04
2. **Install nginx + certbot** and set up SSL for `theater.yourdomain.com`
3. **Add Discord URL Mapping** — `/theater` → `theater.yourdomain.com` in Discord Developer Portal → Activities → URL Mappings
4. **Add Cloudflare IP Access Rule** (if your Express domain uses Cloudflare) — whitelist VPS IP to bypass Bot Fight Mode
5. **Configure nginx** to proxy through Express (not directly to Plex — Plex throttles external delivery)
6. **Add env vars** to `.env`:
   ```env
   VPS_RELAY_URL=https://theater.yourdomain.com
   VPS_RELAY_KEY=your-secret-key
   ```
   Generate key: `openssl rand -hex 32`

See **[docs/vps-relay-setup.md](docs/vps-relay-setup.md)** for the complete nginx config and step-by-step instructions.

### How It Works

When `VPS_RELAY_URL` and `VPS_RELAY_KEY` are set:
- `.ts` segment URLs in HLS manifests are rewritten to `/theater/seg/...` (relative, via Discord's proxy to VPS)
- VPS nginx validates `?key=`, rewrites to `/api/plex/hls/seg?p=...`, proxies to your Express server
- Express checks the segment pre-fetch cache first — if the segment was already fetched ahead of time, it's served instantly
- On cache miss, Express fetches the segment from Plex locally (unthrottled) and returns it
- VPS caches the segment for 5 minutes — subsequent viewers get it instantly from cache
- P2P is automatically disabled (VPS handles fan-out)

Sub-manifests stay on Express for correct URL rewriting. Do NOT proxy directly to Plex:32400 — Plex throttles external HTTP delivery to 1x realtime, causing stuttering.

When env vars are removed, everything reverts to Express proxying with P2P.

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `VPS_RELAY_URL` | No | VPS relay URL (e.g. `https://theater.yourdomain.com`). Omit to disable. |
| `VPS_RELAY_KEY` | No | Shared secret validated by nginx. Must match the key in the nginx config. |

Both must be set to activate. If either is missing, falls back to direct Express proxying with P2P.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Failed to connect to Discord" | Make sure you're launching as a Discord Activity from a voice channel, not visiting the URL directly |
| Library is empty | Check that `PLEX_URL` and `PLEX_TOKEN` are correct and the server can reach Plex |
| Video won't play | Check browser console for HLS errors; ensure Plex can transcode |
| "Session expired" banner | The server restarted and your session is stale — close and reopen the Activity |
| Tunnel URL changed | Update the URL mapping in Discord Developer Portal |
| Audio is MP3 instead of AAC | Normal for incompatible source codecs (TrueHD, DTS) — MP3 works fine in browsers and Discord |
| VPS segments return 403 | Key mismatch — check `VPS_RELAY_KEY` in `.env` matches the key in nginx config |
| VPS segments return 403 (Cloudflare) | Cloudflare blocking VPS — add IP Access Rule to whitelist VPS IP (not WAF Skip rule) |
| VPS segments return 502 | VPS can't reach Express server — check Cloudflare IP Access Rule exists, Express domain DNS resolves |
| VPS causes stuttering | Proxying directly to Plex:32400 — must proxy through Express instead (see docs) |
| Segments blocked in Discord | Missing URL mapping — add `/theater → theater.yourdomain.com` in Discord Dev Portal |

## License

[GPL-3.0](LICENSE)
