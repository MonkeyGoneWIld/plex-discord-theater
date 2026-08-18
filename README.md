# Plex Discord Theater

A Discord Activity that lets you browse your Plex library and watch movies and TV shows together in a voice channel — synchronized playback, host controls, and all streamed through Discord.

## Features

- **Browse and search your library** — movies and TV shows with genre filters and sorting, plus cast and crew pages listing everything they appear in
- **Discover titles you don't own** — search also surfaces them, marked "Not in library", with full detail pages. Optional [Seerr](#optional-integrations) integration adds a Request button, per-season for TV
- **Collections and "More Like This"** — the rest of a franchise and TMDB's suggestions, on every detail page, with titles you don't own marked and requestable. Needs a [TMDB key](#optional-integrations)
- **Ratings** — IMDb, Rotten Tomatoes (critic *and* audience) and TMDB scores on detail pages. Needs an [MDBList key](#optional-integrations)
- **Synchronized playback** — the host drives play/pause/seek and everyone stays in sync. Small drifts are closed by nudging playback speed a few percent rather than by seeking, so staying together doesn't cost a rebuffer every time
- **Co-hosts & host transfer** — hand out transport control, or the host role itself, from the people panel. Roles belong to the person, not the connection, so a dropped socket doesn't quietly demote anyone. If the host leaves, a co-host is promoted so the session continues
- **Audio & subtitle tracks** — switch before playing or mid-episode. Your subtitle choice carries to the next episode, matched by language rather than by track number
- **Skip intro / credits** and **seek-bar thumbnail previews** — both from Plex's own generated data (see the note below)
- **Next episode** — resolved from the series including season rollover, offered on a card when one finishes. Nothing auto-plays
- **Queue & suggestions** — the host queues what's next; viewers can suggest
- **Stats for nerds** — press `i` for resolution, codecs, bitrate, buffer health and P2P counters
- **Secure** — your Plex token never leaves the server; the backend proxies everything

> **Two of these depend on Plex generating the data first**, and both silently do nothing without it: skip intro/credits needs *Detect intros and credits*, seek-bar previews need *Generate video preview thumbnails*. Each is under Library → Edit → Advanced, and both are off by default on many servers.

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

The first user to join becomes the host and can start playback. Everyone else follows over WebSocket. The backend proxies every Plex API call and HLS segment, so nothing is exposed directly to clients. Sessions, host roles and artwork are cached in SQLite and survive restarts.

### Delivering segments

Everything below is about one problem: your home upload. Plex transcodes once, but by default every viewer pulls that stream from your connection.

**VPS relay — the answer for more than a few viewers.** With `VPS_RELAY_URL` set, your server uploads one stream to a VPS and the VPS fans it out from its own connection.

```
Without VPS:  home upload = N viewers × bitrate
With VPS:     home upload = 1 stream (~8-12 Mbps), regardless of viewer count
```

See [VPS Relay](#vps-relay-optional) below to set it up.

**Segment pre-fetching** runs either way. Plex throttles HTTP segment delivery for roughly the first 30 seconds of a transcode, which is exactly when a viewer is waiting. So the server polls the sub-manifest every 2s, pulls discovered segments with 3 workers, and serves them from memory when asked. After a seek it fetches forward from the seek target rather than from the start, and it only ever fetches a fixed window ahead of the *playhead* — hanging it off the transcode head instead lets it run away to the end of the file while the buffer drains behind it.

Memory is capped at 384 MB in total, shared evenly across up to four concurrent sessions, evicting already-served segments first. Total rather than per-session, so the ceiling doesn't move when a second party starts watching. At capacity the oldest session is displaced rather than the newest refused — the usual way to reach capacity is a seek-restart, whose outgoing session is still being torn down while its replacement asks for a manifest, and refusing that one starves the person actually waiting.

**P2P sharing** is the fallback when no VPS is configured. Viewers form a WebRTC mesh via an embedded [bittorrent-tracker](https://github.com/webtorrent/bittorrent-tracker), sharing segments within a watch session and falling back to the server when a peer can't supply one in time.

> P2P carries less than you might expect. The loader prefers HTTP for "high-demand" segments and that window spans the whole 120s buffer, so most segments come from the server and peers help at the margins. That was deliberate — with a narrower window, a viewer with no peers could only buffer ~15s ahead. **For anything beyond a few viewers, use the VPS relay.**

### Transcode settings

| Setting | Value | Reason |
|---------|-------|--------|
| Video codec | H.264 | Universal browser compatibility |
| Audio codec | AAC preferred, MP3 fallback | Compatible audio passes through; incompatible codecs like TrueHD are re-encoded |
| Max resolution | 1920×1080 | Good quality without excessive bandwidth |
| Target bitrate | 12 Mbps (peak 20) | Configurable via `VIDEO_BITRATE_KBPS` / `VIDEO_PEAK_BITRATE_KBPS` |
| Segment duration | 3 seconds | Faster cold start — Plex transcodes only 3s before the first segment is ready |
| Location | LAN | Avoids Plex's WAN throttling |

Video is always re-encoded rather than direct-streamed. Direct streaming hands the source's elementary stream to the browser untouched, including any keyframe or timestamp discontinuity in the file — which MSE cannot append across, wedging playback mid-episode with no recovery.

## Optional Integrations

Every one of these is off unless its variable is set, and every one **fails silently** when it isn't — the row or the button simply doesn't appear, which is easy to mistake for a bug. The server prints which are live at startup, so `docker compose logs | grep Config` will tell you where you stand:

```
[Config] ✓ TMDB   ✓ Ratings   ✓ Requests   ✓ Discover   · VPS relay (P2P mode)   · Guild allowlist (open to any Discord server)
```

`✓` is on, `·` is off with the consequence in brackets.

| Variable | What it turns on | Where to get it |
|---|---|---|
| `TMDB_API_KEY` | Collections, "More Like This", and cast/crew pages | Free v3 key — [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) |
| `MDBLIST_API_KEY` | The ratings row: IMDb, Rotten Tomatoes, TMDB | Free — [mdblist.com/preferences](https://mdblist.com/preferences) → API Access |
| `TVDB_API_KEY` | Correct season numbering for the missing-episode list | Free — [thetvdb.com/api-information](https://thetvdb.com/api-information) |
| `PLEX_ACCOUNT_TOKEN` | Detail pages for titles you don't own, and Seerr sign-in | Your **account** token from an app.plex.tv request (not the server token) |
| `SEERR_URL` | The Request button on out-of-library titles | Your Overseerr / Jellyseerr URL |
| `VPS_RELAY_URL` + `VPS_RELAY_KEY` | [Segment relay](#vps-relay-optional) — one upstream stream instead of one per viewer | Your own VPS |
| `ALLOWED_GUILD_IDS` | Restricts the activity to named Discord servers | Comma-separated guild IDs. Unset = any server |

### TMDB — collections, related titles, people

Powers three things, all on detail pages:

- **"Also in this collection"** — the whole franchise for a film (all eight *Harry Potter*, say), with anything you don't own marked "Not in library" and requestable if Seerr is configured. Without a key the row still appears but lists only what you already have, so a partial series looks complete.
- **"More Like This"** — TMDB's suggestions, owned titles first. Hidden entirely without a key.
- **Cast and crew pages** — everything a person appears in, including titles outside your library.

The key is free and takes about a minute: sign up, then Settings → API → request a v3 key. It's a read-only key for public metadata.

### TVDB — which episodes a season actually has

The missing / not-yet-aired rows inside a season need a list of what the season
is supposed to contain. TMDB can provide it, and mostly does fine — but Sonarr
monitors **TVDB**, and the two do not always agree about which season an episode
belongs to. On a show where they differ, a TMDB-derived list names episodes that
really sit in a neighbouring season, and requesting them achieves nothing
because Sonarr has them numbered the other way.

With `TVDB_API_KEY` set, TVDB is used whenever the show carries a tvdb id.
Either way the list is checked against Plex's own episode numbers first: a
source that can't account for episodes already on disk is describing a different
season, and is discarded rather than shown. Without the key everything still
works, on TMDB numbering.

A free "project" key needs no PIN; a user-supported subscriber key does, and
goes in `TVDB_PIN`.

### MDBList — ratings

Puts IMDb, Rotten Tomatoes and TMDB scores on movie and show pages. Rotten Tomatoes has no public API of its own, so [MDBList](https://mdblist.com) — a free aggregator — is how both the critic Tomatometer and the Audience score are obtained. Free key from [mdblist.com/preferences](https://mdblist.com/preferences) under API Access. Left unset, the ratings row is hidden and nothing else changes.

### Seerr — requesting titles

Set `SEERR_URL` to enable the Request button; leave it unset and the button is hidden. Requests are attributed to **your own Seerr account** — the server signs in with `PLEX_ACCOUNT_TOKEN` rather than an admin API key, so there is no `SEERR_API_KEY` to set. Movies request in one click; TV offers per-season selection showing what you already have, what's pending, and what's available.

All Seerr calls go through the server, because the Activity runs in a sandboxed cross-origin iframe and can't reuse your browser's Overseerr session.

## Tech Stack

| Layer | Technology |
|-------|------------|
| Client | React, hls.js, [p2p-media-loader](https://github.com/nicedoc/p2p-media-loader), Discord Embedded App SDK |
| Server | Express, WebSocket (ws), bittorrent-tracker, better-sqlite3 |
| Streaming | HLS via Plex transcoder, server-side segment pre-fetch cache, WebRTC P2P sharing |
| Infrastructure | Docker, Node.js 24, optional nginx VPS relay |

## Setup

You'll need Node.js 24+ (or Docker), a Plex Media Server reachable from the backend, a Discord application with Activities enabled, and a public HTTPS URL for Discord's iframe proxy.

### 1. Discord Developer Portal

1. Create an application at [discord.com/developers/applications](https://discord.com/developers/applications)
2. Under **Activities → Settings**, enable Activities
3. Add a URL mapping: `/` → your server's public URL
4. Copy the **Client ID** and **Client Secret**

### 2. Plex token

Open Plex Web, play anything, and look for `X-Plex-Token=` in the Network tab — or follow the [official guide](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

### 3. Environment

```bash
cp .env.example .env
```

`.env.example` documents every variable, required and optional. The required ones:

```env
DISCORD_CLIENT_ID=your_discord_client_id
DISCORD_CLIENT_SECRET=your_discord_client_secret
PLEX_URL=http://localhost:32400
PLEX_TOKEN=your_plex_token
PORT=3000
REDIRECT_URI=https://your-public-url.example.com
ALLOWED_ORIGINS=https://your-public-url.example.com
```

Everything else is optional — see [Optional Integrations](#optional-integrations) for what each one turns on and where to get the keys. `TMDB_API_KEY` and `MDBLIST_API_KEY` are the two worth setting first: both are free, and between them they fill in the collection rows, "More Like This", cast pages and the ratings row.

For local development, also create `packages/client/.env`:

```env
VITE_DISCORD_CLIENT_ID=your_discord_client_id
```

### 4. Run

```bash
docker compose up --build     # Docker (recommended)
npm install && npm run dev    # or local: server on :3000, client on :5173
```

Discord Activities require a public HTTPS URL. For local dev:

```bash
cloudflared tunnel --url http://localhost:5173
```

Set the resulting URL as your Discord URL mapping. It changes on every restart — use a [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/) for a stable one.

### 5. Deploy

```bash
npm run deploy                              # build and push the image
docker compose pull && docker compose up -d # on your server
```

### 6. Launch

Join a voice channel, click the **Activities** (rocket) icon, and pick your app.

## VPS Relay (Optional)

Routes HLS segments through a VPS (~$7/mo) so your home connection uploads one stream instead of one per viewer. At 10 viewers and 8 Mbps that's the difference between 80 Mb/s and ~8 Mb/s.

1. **Create a VPS** — e.g. Hetzner CAX11/CX23, Ubuntu 24.04, primary IPv4
2. **Install nginx + certbot**, set up SSL for `theater.yourdomain.com`
3. **Add a Discord URL mapping** — `/theater` → `theater.yourdomain.com`
4. **Whitelist the VPS IP in Cloudflare** (IP Access Rule, not a WAF Skip rule) if your Express domain sits behind it
5. **Configure nginx** to proxy through Express — *not* directly to Plex:32400, which throttles external delivery to 1× realtime and stutters
6. **Set both env vars** (`VPS_RELAY_KEY` via `openssl rand -hex 32`):
   ```env
   VPS_RELAY_URL=https://theater.yourdomain.com
   VPS_RELAY_KEY=your-secret-key
   ```

Full nginx config and step-by-step instructions: **[docs/vps-relay-setup.md](docs/vps-relay-setup.md)**.

Once both variables are set, segment URLs are rewritten to `/theater/seg/...`, nginx validates the key and proxies to Express, Express serves from the pre-fetch cache or fetches from Plex locally, and the VPS caches the result for 5 minutes. Sub-manifests stay on Express so URLs rewrite correctly. P2P turns itself off. Remove either variable and everything reverts to Express proxying with P2P.

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "Failed to connect to Discord" | Launch it as an Activity from a voice channel, not by visiting the URL directly |
| Library is empty | Check `PLEX_URL` / `PLEX_TOKEN`, and that the server can reach Plex |
| Video won't play | Check the browser console for HLS errors; confirm Plex can transcode |
| "Session expired" banner | The server restarted — close and reopen the Activity |
| "Reconnecting…" banner | The sync socket dropped and is retrying. Your own playback keeps going; the room just can't see you until it's back. It clears itself, or offers a Reconnect button once the automatic attempts run out |
| "Unknown instance" on join | The activity instance was never registered, or its registration expired after 24h idle. Close and reopen the Activity |
| Tunnel URL changed | Update the URL mapping in the Discord Developer Portal |
| Audio is MP3, not AAC | Expected for TrueHD/DTS sources. MP3 plays fine everywhere |
| Skip intro / previews missing | Plex hasn't generated them — see the note under Features |
| No ratings on detail pages | `MDBLIST_API_KEY` isn't set — see [Optional Integrations](#optional-integrations) |
| No collections or "More Like This" | `TMDB_API_KEY` isn't set. A partial collection row (only titles you own) means the same thing |
| Not sure which integrations are live | `docker compose logs \| grep Config` — the server prints them at startup |
| VPS segments 403 | Key mismatch between `.env` and the nginx config — or Cloudflare blocking the VPS, which needs an IP Access Rule |
| VPS segments 502 | The VPS can't reach Express — check that Cloudflare rule and your Express domain's DNS |
| VPS stutters | nginx is proxying straight to Plex:32400; it must go through Express |
| Segments blocked in Discord | Missing `/theater` URL mapping in the Developer Portal |

## License

[GPL-3.0](LICENSE)
