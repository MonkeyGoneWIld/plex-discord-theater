# Local Development

How to run the project from source, how it is organised, and how to test it.
You don't need any of this to run the Activity: see
[Installation](Installation).

## Run it locally

You need Node.js 24 or later, and an HTTPS address for Discord (below).

```bash
git clone https://github.com/MonkeyGoneWIld/plex-discord-theater.git
cd plex-discord-theater
npm install
cp .env.example .env
```

Fill in `.env` as described in [Installation](Installation#2-fill-in-the-required-values).

The client needs the Discord application ID at build time in development.
Create `packages/client/.env` with:

```bash
VITE_DISCORD_CLIENT_ID=your_discord_client_id
```

In production the server adds the ID to the page when it serves it, so the
published image works with any application.

Start both parts:

```bash
npm run dev
```

The server runs on port 3000 and reloads when its code changes. The Vite
client runs on port 5173 with hot reload, and passes API and WebSocket requests
to the server.

The development scripts use POSIX shell syntax. On Windows, run them in WSL.

### Give Discord an HTTPS address

Discord only loads an Activity over HTTPS. A Cloudflare quick tunnel to the
Vite client is the simplest way:

```bash
cloudflared tunnel --url http://localhost:5173
```

Map the address it prints in the Discord Developer Portal, as in
[Discord Application Setup](Discord-Application-Setup#4-map-the-url), and set
`REDIRECT_URI` and `ALLOWED_ORIGINS` to it. A quick tunnel's address changes
each time it starts; for longer work, use a named tunnel as described in
[HTTPS and Reverse Proxy](HTTPS-and-Reverse-Proxy).

## Commands

| Command | Does |
|---|---|
| `npm run dev` | Server and client, with reloading |
| `npm run build` | Builds the client, then the server |
| `npm start` | Runs the built server |
| `npm test` | Runs the test suite |
| `npx tsc --noEmit -p packages/server` | Type-checks the server |
| `npx tsc --noEmit -p packages/client` | Type-checks the client |

## Project layout

```text
packages/
  client/            The React app Discord shows
    src/components/  Player, controls, library and title pages, panels
    src/hooks/       Discord sign-in (useDiscord) and the room connection (useSync)
    src/lib/         Playback helpers: quality, subtitles, previews, P2P, settings
    test/            Tests, and browser fixtures run by hand
  server/            Express and WebSocket server
    src/routes/      Plex, Discord sign-in, history, Plex accounts, Seerr,
                     presence, logs, the qBittorrent manager API
    src/services/    Rooms, Plex, Direct Stream, subtitles, caches, P2P tracker
    src/services/ffmpeg/  The FFmpeg engine
    src/middleware/  Sign-in checks and request limits
    test/            Tests
scripts/             Diagnosis scripts run inside the container
docs/                Screenshots, this wiki's source
```

## How it works

| Part | Where | What it does |
|---|---|---|
| Rooms | `services/sync.ts` | A WebSocket protocol. The server checks every control message against the sender's role, so a modified client can't control a room it doesn't host. |
| Plex engine | `routes/plex.ts` | Plex's HLS transcoder, through the server. The Plex token never reaches a browser. |
| Direct Stream | `services/direct-stream.ts` | Plex copying the video instead of re-encoding it. The server builds the playlist from the segments as they arrive, and keeps them in memory and then on disk until the stream ends. |
| FFmpeg engine | `services/ffmpeg/` | The server's own ffmpeg reads the library files directly. See [FFmpeg Engine](FFmpeg-Engine). |
| Streams per room | `services/sync.ts` | A room has a stream for each combination of audio track, burned-in subtitle and quality in use, shared by everyone on it |
| Peer-to-peer | `p2p-media-loader`, `services/tracker.ts` | Viewers on the same stream share segments. The library is patched as it is bundled, by `packages/client/p2pCorePatch.ts`. |
| qBittorrent manager API | `routes/qbt-manager.ts` | See [qBittorrent Manager API](qBittorrent-Manager-API) |

The two largest files are `packages/server/src/routes/plex.ts`, for the Plex
proxy and stream sessions, and `packages/client/src/components/Player.tsx`, for
playback.

## Technology

| Layer | Technology |
|---|---|
| Client | React 19, hls.js, p2p-media-loader, Discord Embedded App SDK |
| Server | Express, ws, better-sqlite3, bittorrent-tracker |
| Build | Vite, TypeScript |
| Image | Node.js 24 on Debian (trixie), jellyfin-ffmpeg 8.1.3, Intel's OpenCL runtime |

The image runs as an unprivileged user, `appuser` (UID 100, GID 101). Its
health check calls `/api/health` with Node, since the image has no `curl` or
`wget`.

## Tests

The tests are plain TypeScript scripts run with `tsx`, without a test
framework. Each file runs on its own and prints its results:

```bash
npx tsx packages/server/test/variant-sync.test.ts
```

`npm test` runs them all. Server tests keep their databases in temporary
folders, so they never touch the `packages/server/data` folder that
`npm run dev` uses.

The TypeScript configuration covers `src` only, so `tsc --noEmit` doesn't
check the test files; `tsx` does when it runs them.

### Browser fixtures

Some fixtures mount the real components in a browser and are run by hand.
Start the client with `npm run dev -w packages/client`, then open one of:

| Fixture | Needs |
|---|---|
| `/test/audio-boost.html`, `/test/breadcrumbs.html`, `/test/gop-trim.html`, `/test/host-toast.html`, `/test/library-loading.html`, `/test/pip-interactions.html`, `/test/season-detail.html`, `/test/settings-panel.html`, `/test/stats-panel.html`, `/test/subtitle-panel.html`, `/test/sync-player.html`, `/test/track-switcher.html` | Nothing more |
| `/test/media-errors.html` | `node packages/client/test/media-errors-server.mjs`, which needs `ffmpeg` on the PATH the first time |
| `/test/sync-room.html` | `npx tsx packages/client/test/sync-room-server.ts`, after the media-errors server has run once. It plays a room of players against the real sync server and P2P tracker. |

## Releases

Pushing a tag such as `v2.1.0` runs `.github/workflows/release.yml`. It runs
the tests and type checks, builds the image, and publishes it to GitHub
Container Registry as `ghcr.io/monkeygonewild/plex-discord-theater`, tagged
`2.1.0`, `2.1`, `2` and `latest`. Images are built for amd64 only. The workflow
can also be started by hand with a tag, to retry a failed publish.

## Contributing

This project is a fork of
[ZubyWasTaken/plex-discord-theater](https://github.com/ZubyWasTaken/plex-discord-theater).
Changes that suit the original project are best sent there.

It is licensed under GPL-3.0: anything you distribute that is built on it must
use the same licence.

## Next

→ [Troubleshooting](Troubleshooting)
