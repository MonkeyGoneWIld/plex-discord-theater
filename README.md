# Plex Discord Theater

**Watch your Plex library together, inside Discord.**

Plex Discord Theater is a Discord Activity for synchronized watch parties from
your own Plex Media Server. One person hosts, playback stays in step for
everyone in the room, and each viewer picks their own audio, subtitles and
quality.

![A synchronized Plex watch party running inside Discord](docs/screenshots/player.jpg)

**[Documentation](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki)** ·
**[Quick start](#quick-start)** ·
**[Features](#features)** ·
**[For server owners](#for-server-owners)**

Current release: **v2.2.0** · `ghcr.io/monkeygonewild/plex-discord-theater:latest`

> [!WARNING]
> **This project was built with AI.** It was developed primarily with
> AI-assisted tooling and has not had an external security review. Treat it as
> a hobby project: run it on infrastructure you control, for people you know,
> and do not expose it as a public service.

## Why you'll like it

| | |
|---|---|
| **One room, one timeline** | The host plays, pauses and seeks, and everyone stays in step. No screen sharing, no countdowns. |
| **Your whole library** | Browse the same home screen, libraries, search and title pages you know from Plex. |
| **Everyone's own choices** | Each viewer picks their audio track, subtitles and quality without changing anyone else's. |
| **The original picture** | Files your viewers can play are sent as they are, 4K and HDR included. Nothing is re-encoded unless it has to be. |
| **Desktop and mobile** | Works in Discord on Windows, macOS, Linux, the web, iOS and Android. |
| **Yours to run** | One Docker container beside your Plex server. Your Plex token never leaves it. |

## Features

### Watch together

Launch the Activity from any voice or text channel and everyone who joins lands
in the same room. The host controls the timeline, can name co-hosts, and can
hand the room to someone else. Viewers can suggest what to watch next, ask for
a pause, or ask to take over when the host has stepped away.

- **Up next** offers the next episode near the end. Nothing starts by itself.
- **Skip Intro** and **Skip Credits**, from Plex's own markers.
- **Picture-in-picture** keeps the film playing while you browse.
- **Discord Rich Presence** shows what the room is watching on your profile.

![Picture-in-picture: the film playing in a floating window over a title page](docs/screenshots/pip-title.jpg)

### A full Plex browser

The home screen shows the hubs Plex generates, including Continue Watching.
Search covers your library and Plex Discover, and title pages carry ratings,
cast, collections, versions and tracks.

![The Plex-style home screen inside the Activity](docs/screenshots/home.jpg)

![A title page with playback details and track choices](docs/screenshots/title.jpg)

### Audio, subtitles and quality for each viewer

Every viewer chooses their own audio track, subtitles and quality, and those
choices carry into the next episode. A viewer on a slow connection can lower
their quality and gets a stream of their own, so nobody else's picture drops.

Subtitles are drawn by each player. Their size, position, colour and timing
can be adjusted from the player.

![The subtitle panel open in the player, beside a subtitle drawn over the film](docs/screenshots/subtitle-look.jpg)

### Built for phones too

| ![Browsing movies on a phone](docs/screenshots/phone-browse.jpg) | ![A movie detail page on a phone](docs/screenshots/phone-title.jpg) |
| :-- | :-- |
| Compact library rows. | Title pages sized for a phone. |

### Personal Plex sync

Each viewer can link their own Plex account through Plex's sign-in page. Watch
progress and watched status then sync to their account, and their Universal
Watchlist appears as a tab.
[More →](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Personal-Plex-Sync)

### Requests through Seerr

Connect Overseerr or Jellyseerr and a **Request** button appears on titles that
are not in your library. Movies take one click; for shows, viewers choose the
seasons.
[More →](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Requesting-Titles)

![Requesting a movie from its title page](docs/screenshots/request-movie.jpg)

## How it works

```mermaid
flowchart LR
  V1["Viewer in Discord"] <--> P["Discord's proxy and cache"]
  V2["Viewer in Discord"] <--> P
  V1 <-. "viewers share video with each other" .-> V2
  P <--> T["Plex Discord Theater<br/>your Docker container"]
  T <--> X["Your Plex Media Server"]
```

- **The Activity** is a web app that Discord loads for everyone in the channel.
  It talks only to your Theater container, through Discord's proxy.
- **Theater** keeps the room in sync, asks Plex for the library, and serves the
  video. Your Plex token stays on the server.
- **Video** is sent as it is in the file whenever the viewer's device can play
  it. Otherwise it is transcoded, by Plex or by Theater's own FFmpeg engine,
  only for the viewers who need it.
- **Delivery** is shared. Discord's proxy caches each piece of video, and
  viewers on the same stream pass pieces to each other, so a full room costs
  your upload far less than one stream per viewer.

## For server owners

- **Direct play first.** H.264 and HEVC files within your bitrate limit
  are sent unchanged, 4K and HDR included.
- **A stream for each device.** A viewer whose device can't play the room's
  stream, or who lowers their quality, gets a stream of their own. Everyone
  else keeps the original.
- **Optional FFmpeg engine.** Theater can make the streams itself on Intel
  Quick Sync, VAAPI or NVIDIA NVENC. It keeps HDR, draws Blu-ray and DVD
  subtitles in the player without burning them in, and makes seek previews
  for files Plex has none for.
  [More →](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/FFmpeg-Engine)
- **Dashboard.** An optional page on its own port, for you only. It shows what
  is playing right now, who is watching, why each stream is direct or
  transcoded, and where the data is coming from, with a full history,
  statistics, users, requests, caches and logs.
  [More →](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Dashboard)
- **qBittorrent upload limits.** The optional
  [plex-qbt-manager](https://github.com/MonkeyGoneWIld/plex-qbt-manager) makes
  room in qBittorrent's upload while people watch.
- **Private by design.** Plex tokens never reach a browser, and the Activity
  can be limited to your own Discord servers.

## Quick start

You need:

- A Plex Media Server
- Docker
- A Discord application with Activities enabled
- A public HTTPS address that forwards to the container, such as a Cloudflare
  Tunnel

The [Installation guide](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Installation)
walks through each step in detail.

### 1. Create the Discord application

In the [Discord Developer Portal](https://discord.com/developers/applications),
create an application, enable **Activities**, map `/` to your public HTTPS
host, and copy the **Application ID** and **Client Secret**.
[Step by step →](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Discord-Application-Setup)

### 2. Get your Plex token

Follow Plex's
[authentication token guide](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

### 3. Deploy with Docker Compose

Fill in the six required values. Everything else has a sensible default.

```yaml
services:
  plex-discord-theater:
    image: ghcr.io/monkeygonewild/plex-discord-theater:latest
    container_name: plex-discord-theater
    restart: unless-stopped
    ports:
      - "3000:3000"
      # The dashboard, on your LAN only (set ADMIN_PASSWORD below).
      # - "192.168.1.10:3050:3050"
    volumes:
      - app-data:/data
    environment:
      # ── Required ──────────────────────────────────────────────
      # From the Discord Developer Portal.
      DISCORD_CLIENT_ID: ""
      DISCORD_CLIENT_SECRET: ""
      # Your Plex server as the container reaches it, and its token.
      PLEX_URL: "http://192.168.1.50:32400"
      PLEX_TOKEN: ""
      # Your public HTTPS address, with no trailing slash.
      REDIRECT_URI: "https://watch.example.com"
      ALLOWED_ORIGINS: "https://watch.example.com"

      # ── Recommended: complete title and cast pages ────────────
      # Your plex.tv account token (not the server token above).
      # PLEX_ACCOUNT_TOKEN: ""
      # Free key from https://www.themoviedb.org/settings/api
      # TMDB_API_KEY: ""

      # ── Optional ──────────────────────────────────────────────
      # Limit the Activity to these Discord servers (IDs, comma-separated).
      # ALLOWED_GUILD_IDS: ""
      # The Request button, through Overseerr or Jellyseerr.
      # SEERR_URL: "https://requests.example.com"
      # The dashboard on port 3050. Use 12 characters or more.
      # ADMIN_PASSWORD: ""

      # Leave this as it is: it matches the volume above.
      THUMB_CACHE_DIR: "/data"

volumes:
  app-data:
```

```bash
docker compose up -d
```

Every setting, including bitrates, caches and the FFmpeg engine, is in the
[Configuration Reference](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Configuration-Reference).

### 4. Launch it in Discord

In a voice or text channel, open the **App Launcher** and pick your
application. **Invite to Activity** brings others into the same room.
[First Launch](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/First-Launch)
covers your first watch party.

> An unverified Discord application works in servers with fewer than 25
> members, and each viewer must be added as an App Tester. See
> [Discord Application Setup](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Discord-Application-Setup).

## Documentation

| | |
|---|---|
| **Set up** | [Requirements](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Requirements) · [Installation](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Installation) · [Discord Application Setup](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Discord-Application-Setup) · [Plex Setup](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Plex-Setup) · [HTTPS and Reverse Proxy](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/HTTPS-and-Reverse-Proxy) · [First Launch](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/First-Launch) |
| **Use** | [Using the Activity](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Using-the-Activity) · [Roles and Permissions](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Roles-and-Permissions) · [Personal Plex Sync](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Personal-Plex-Sync) · [Requesting Titles](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Requesting-Titles) |
| **Run** | [Streaming and Quality](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Streaming-and-Quality) · [FFmpeg Engine](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/FFmpeg-Engine) · [Dashboard](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Dashboard) · [Configuration Reference](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Configuration-Reference) · [Optional Integrations](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Optional-Integrations) · [Updating and Backups](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Updating-and-Backups) |
| **Help** | [Troubleshooting](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Troubleshooting) · [FAQ](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/FAQ) · [Local Development](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Local-Development) |

## Data and privacy

Your Plex token stays on the server, which proxies every Plex request and all
video. Viewers who link a Plex account sign in on Plex's own page, and their
tokens are encrypted at rest. Sessions, watch history and cached artwork are
kept in SQLite on the data volume. See
[Updating and Backups](https://github.com/MonkeyGoneWIld/plex-discord-theater/wiki/Updating-and-Backups)
for what is stored and what to back up.

## License

[GPL-3.0](LICENSE)
