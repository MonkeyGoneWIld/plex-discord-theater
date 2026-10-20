# Troubleshooting

Grouped by where the problem shows up. Start with the section that matches what
you are seeing.

**Before anything else**, two commands answer most questions:

```bash
docker compose ps
docker compose logs | grep Config
```

The first tells you whether the container is healthy. The second tells you which
integrations are actually on.

---

## Setup and startup

### The container will not start

Check the logs:

```bash
docker compose logs --tail 50
```

**"Missing required environment variable: X"** — exactly what it says. All six
of `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `PLEX_URL`, `PLEX_TOKEN`,
`REDIRECT_URI` and `ALLOWED_ORIGINS` must be set. See
[Configuration Reference](Configuration-Reference#required).

**Port already in use** — something else holds port 3000. Change the published
port in `docker-compose.yml`.

**Build fails compiling a native module** — the build needs to compile
`better-sqlite3`. Make sure Docker has enough memory allocated, and retry.

### The container is `unhealthy`

The health check probes Plex, so `unhealthy` means the container cannot reach
your Plex server. Almost always `PLEX_URL`.

Test from inside the container:

```bash
docker compose exec plex-discord-theater wget -qO- "$PLEX_URL/identity?X-Plex-Token=$PLEX_TOKEN"
```

XML back means it works. Anything else, re-read
[Plex Setup](Plex-Setup#setting-plex_url) — and remember `localhost` inside a
container is the container itself.

---

## Discord

### The Activity does not appear in the rocket menu

Work through these in order:

1. **Are you in a voice channel?** Activities only appear there.
2. **Does the server have fewer than 25 members?** An unverified app is limited
   to servers under 25 members. See
   [the 25-member limit](Discord-Application-Setup#the-25-member-limit).
3. **Are you an app tester?** Anyone not on the developer team must be added
   under **App Testers** and must accept the invitation. See
   [Adding app testers](Discord-Application-Setup#adding-app-testers).
4. **Are Activities enabled?** **Activities → Settings** in the Developer Portal.
5. **Is the URL mapping set?** Same page — a mapping from `/` to your host.

### "Failed to connect to Discord"

You opened the URL directly in a browser instead of launching it as an Activity
from a voice channel. The Discord SDK is only available inside the Activity
iframe.

### The Activity loads a blank page

Usually a mismatch between `REDIRECT_URI` / `ALLOWED_ORIGINS` and the URL
mapping in the Developer Portal. All three must be the same address, including
`https://` and without a trailing slash.

Open the browser console inside the Activity (`Ctrl+Shift+I` in the Discord
desktop app) and look for CORS or CSP errors.

### The Activity worked yesterday and does not today

If you use a temporary Cloudflare Tunnel, the address changed. Update the URL
mapping in the Developer Portal, or switch to a
[named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/).

### The Discord profile shows no artwork or progress

- **No artwork.** Discord fetches the poster from your public address, the one
  in `REDIRECT_URI`, at `/api/presence/artwork/<id>`, through its own image
  proxy. It has to be reachable without a login, so a Cloudflare Access page or
  basic auth in front of the whole host blocks it; exempt that path. The link
  serves only that one cached poster, never anything else from Plex, and it
  expires after 24 hours.
- **No progress bar.** Discord shows one only while the room plays and the
  title's length is known. Pause removes it, and resuming or seeking puts it
  back.
- **A plain watching status, without the title.** That viewer turned off
  **Show media details on Discord** under **People**. It is saved per device.
- **Nothing at all.** The viewer didn't give the Activity permission to set
  their status when it asked. Playback works either way.

Discord decides each card's layout; a compact pop-out can't be made to show the
full profile card.

---

## Library and browsing

### The library is empty

1. Check `PLEX_URL` and `PLEX_TOKEN`.
2. Confirm the container can reach Plex (see
   [unhealthy](#the-container-is-unhealthy) above).
3. Confirm the token is a **server** token, not an account token.

### Detail pages are blank for titles I do not own

Set `PLEX_ACCOUNT_TOKEN`. The Plex cloud rejects the server token, so Discover
results appear but their details cannot be fetched. See
[Plex Setup](Plex-Setup#getting-plex_account_token).

### No ratings

Ratings come from Plex metadata when available. For titles outside your library,
configure `PLEX_ACCOUNT_TOKEN` and verify that Plex Discover details load. Some
titles may not have every rating source.

### Collection rows only show films I already own

Set `TMDB_API_KEY`. Without it the row is built from your library alone.

### No "More Like This" row

Same — `TMDB_API_KEY`.

### Missing episodes are numbered oddly

Set `TVDB_API_KEY` so the list uses the same source Sonarr does. See
[Optional Integrations](Optional-Integrations#tvdb--accurate-missing-episode-lists).

### No Request button

Set both `SEERR_URL` and `PLEX_ACCOUNT_TOKEN`. Either alone is not enough.

---

## Playback

### Video will not play

1. **Can Plex transcode it?** Try the same title in Plex Web with a forced
   quality change. If Plex cannot transcode it, this cannot either.
2. **Is the transcoder overloaded?** Check the Plex dashboard. "Transcode
   (throttled)" or a pinned CPU means your hardware is the limit — see
   [Requirements](Requirements#hardware-honestly).
3. **Check the browser console** inside the Activity for HLS errors.
4. **Check the server logs** for `[HLS]` lines.

### Playback stutters or buffers constantly

Almost always bandwidth. Each viewer downloads their stream from your server:
roughly `VIDEO_BITRATE_KBPS` for a re-encode, and the file's own bitrate for a
copy (Direct Stream). **Stats for nerds** (`I`) shows which, and whether the
viewer's connection is keeping up: **Connection** turns amber, then red, as it
falls behind.

![Stats for nerds, with the buffer and connection graphs](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/stats.png)

- One viewer struggling: they can pick a lower **Quality** in the player, which
  gives them a stream of their own. After a lot of buffering the player offers
  one.
- Everyone struggling: lower `VIDEO_BITRATE_KBPS` (`6000` roughly halves a
  re-encode), or `DIRECT_STREAM_MAX_KBPS` so the biggest files are re-encoded
  instead of copied.
- Or set up the [VPS Relay](VPS-Relay), which is the real fix for rooms above
  three or four people.

### A stream is re-encoded when it could be copied

**Stats for nerds** → **Playback** says why. The reasons are listed under
[`DIRECT_STREAM`](Configuration-Reference#direct_stream).

![Stats for nerds on a re-encoded stream, with the reason under Playback](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/stats-reencoded.png)

Two that catch people out:

- **Plex treats the bot as remote** and holds it to your remote-streaming
  limits. Plex's log says `(WAN)` next to the bot's requests; see
  [Let Plex treat the bot as local](Plex-Setup#let-plex-treat-the-bot-as-local).
- **The player can't decode HEVC.** Discord in Firefox can't, so that viewer
  gets an H.264 re-encode of their own; the Discord app can.

### Buffering when the host changes

A host change doesn't restart anybody's stream: someone else on it takes it
over. A player whose own connection was behind may still buffer briefly.

If it lasts much longer, that player likely had very little buffered at the
moment of handover. The client watches for a genuinely wedged playhead and
restarts its loader automatically, so this should recover on its own. Persistent
cases are worth reporting with logs.

### Coming back from a pop-out takes several seconds

Discord reloads the Activity to pop it out and back. Usually what the page had
downloaded is kept for the next one, and it is playing again in a second or two.
It takes longer when there is nothing to pick up:

- **Discord in Firefox** doesn't let the Activity keep anything.
- The first time the Activity opens on a device, or after a switch to another
  device.
- A stream that started just before, which the page before hadn't downloaded
  yet.

Nobody else in the room waits meanwhile.

### The server's memory keeps growing while a film plays

Expected, up to a limit: the films being played are kept so that going back
plays at once, by default up to 6 GB for copies and 2 GB for re-encodes. Lower
`DIRECT_STREAM_MEMORY_MB` and `TRANSCODE_CACHE_MB` on a small server; see
[Stream caches](Configuration-Reference#stream-caches).

### An episode ends before the timeline does

Some files' picture stops short of the runtime Plex reports, usually by about a
minute, during the end credits, and Plex pads the rest. The player notices when
the padding loads, shortens the timeline to where the picture really ends, and
ends the episode there with the next one offered. Nothing is wrong with your
setup; the only way to get the missing seconds back is a better copy of the file.

### No Skip Intro, Skip Credits, or preview thumbnails

Plex has not generated the underlying data. In Plex:

- **Library → Edit → Advanced → Detect intros and credits**
- **Library → Edit → Advanced → Generate video preview thumbnails**

Both run as background tasks and take a while on a large library.

### Preview thumbnails are slow on a very long film

Expected, and harmless. Preview data for a six-hour video can be tens of
megabytes. A sparse first set of frames arrives at once, so scrubbing has
pictures straight away; the rest wait for the video to buffer and pause whenever
the playback buffer runs low, so they finish later rather than interrupting the
stream. Until then a preview may show a nearby frame rather than the exact one.

### Subtitles are out of sync

Use the **subtitle settings** button in the player bar: **earlier** and
**later** shift them live, and the reset puts back the original timing.

![Subtitle timing, with the −50 ms and +50 ms buttons](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/subtitle-timing.png)

### Subtitle formatting tags appear on screen

Fixed — markup in sidecar subtitles is stripped. If you still see tags, you are
on an older build; rebuild with `docker compose up -d --build`.

---

## FFmpeg engine

The startup line says what the [ffmpeg engine](FFmpeg-Engine) found:

```bash
docker compose logs | grep 'playback engine'
```

### Every stream is still Plex's

- `playback engine: Plex`: `PLAYBACK_ENGINE` isn't `ffmpeg`.
- `ffmpeg wanted … but not found`: the image has no ffmpeg at `FFMPEG_PATH`.
  Pull a current image, and unset `FFMPEG_PATH`.
- **Stats for nerds** (`I`) says `Engine: Plex` for one stream only: ffmpeg
  left it to Plex. The log says why, on a `[FFmpeg] … left to Plex` line; the
  reasons are under
  [When a stream goes to Plex](FFmpeg-Engine#when-a-stream-goes-to-plex).

### Re-encodes run on the CPU

The startup line ends `re-encodes on CPU (…)`, with the reason in brackets:

- `no /dev/dri/renderD128; /dev/dri has: …`: the GPU isn't mapped in. Add
  `/dev/dri:/dev/dri` under `devices`. If Docker runs inside a Proxmox LXC or
  a VM, pass the GPU through to that first. It is looked for again before each
  re-encode, so no restart is needed once it is there.
- `Intel QSV didn't encode: …`: the GPU is there and the test encode failed.
  Run the GPU check, which tries each step on its own:

  ```bash
  docker exec -it plex-discord-theater node scripts/diagnose-ffmpeg.mjs gpu
  ```

### `intel_gpu_top` shows nothing during a re-encode

Read the `gpu=` field on the re-encode's `[FFmpeg] run stopped` line (and on its
`far enough ahead` line) instead. It comes from the kernel's count of that
process's GPU time: something like `gpu=video 34%, render 12%, …`, or
`gpu=none: ffmpeg had no GPU open, so the CPU did the work`. On the test server,
`intel_gpu_top` showed every engine idle through re-encodes the kernel had on
the GPU.

### Seeks are slow, or the log says `source=plex`

ffmpeg couldn't read the file at its path here, and read it from Plex over the
network instead. Mount the library, or fix
[`MEDIA_PATH_MAP`](FFmpeg-Engine#library-paths). To check every library:

```bash
docker exec -it plex-discord-theater node scripts/diagnose-ffmpeg.mjs paths
```

### The stream isn't in Plex's dashboard or Tautulli

It is reported to Plex unless `FFMPEG_REPORT_TO_PLEX=0`, under `PLEX_TOKEN`'s
account, as the player **Plex Discord Theater**. Plex lists it as Direct Play
and can't stop it. Stop it from the Activity.

---

## Room and sync

### Stuck on "Reconnecting…"

The room WebSocket dropped. Playback continues locally while it retries.

If it never reconnects, your reverse proxy is probably not passing WebSocket
upgrades. See the nginx snippet in
[Installation](Installation#a-reverse-proxy) — `Upgrade` and `Connection`
headers must be forwarded.

### "Session expired"

The server restarted. Close and reopen the Activity.

### "Unknown instance"

Discord's Activity registration went stale after inactivity. Close and reopen
the Activity.

If it happens repeatedly, another party may be claiming the same channel
registration — check whether the same channel is being used by two instances.

### People see different positions

Small drift is normal and self-corrects. Large drift usually means one viewer's
stream is starved — check their bandwidth, and see
[stutters](#playback-stutters-or-buffers-constantly).

---

## VPS relay

### Segments return 403

Verify `VPS_RELAY_KEY` matches on both sides, and that Cloudflare allows the
VPS IP.

### Segments return 502

The VPS cannot reach the Activity backend. Check DNS, firewall and proxy
settings.

### Playback stutters through the relay

nginx must proxy segments **through the Activity backend**, not directly to
Plex.

### Discord blocks relay segments

Add the `/theater` URL mapping in the Discord Developer Portal. See
[Discord Application Setup](Discord-Application-Setup#4-add-the-url-mappings).

---

## Getting logs

Diagnostic logs are written to `/data/logs`, with Plex and session tokens
redacted automatically.

```bash
docker cp plex-discord-theater:/data/logs ./logs
```

Both server events and connected clients' player events land in the same file,
so a stream that died can be reconstructed after the container logs have rolled
away.

For a specific playback problem, turn on verbose logging temporarily:

```env
DEBUG=1
```

Then reproduce the problem and turn it off again — it produces roughly five
times the log volume.

---

## Still stuck?

Open an issue with:

- What you expected and what happened
- Relevant lines from `docker compose logs`
- The `[Config]` line, so it is clear what is enabled
- Your browser and platform (desktop app, browser, phone)

Please redact anything that looks like a token, even though the log writer
redacts the ones it knows about.
