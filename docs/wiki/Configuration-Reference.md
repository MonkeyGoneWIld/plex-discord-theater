# Configuration Reference

Every environment variable, what it does, and when you would change it.

Set these under `environment:` in the compose file from the
[README](https://github.com/MonkeyGoneWIld/plex-discord-theater#3-deploy), as
`KEY: "value"`, quoted. Building from source instead, they go in `.env` next to
`docker-compose.yml`, as `KEY=value`, with no quotes and no spaces around the
`=`.

Most settings left unset simply turn their feature off — the related row, tab
or button is hidden rather than broken. The few that are on unless set to `0`,
such as [Direct Stream and HEVC](#direct-stream-and-hevc), say so.

---

## Required

These six must be set or the server refuses to start.

### `DISCORD_CLIENT_ID`

Your Discord Application ID, from **General Information** in the Developer
Portal.

Not a secret — it is served to every viewer's browser.

Read at **runtime**: the server injects it into the page on each request. A
restart is enough to change it, and one container image works for any
deployment.

### `DISCORD_CLIENT_SECRET`

From **OAuth2 → Reset Secret**. A real secret — keep it out of screenshots and
commits.

Also doubles as the fallback encryption key for linked Plex accounts if
`PLEX_LINK_SECRET` is unset, which is why rotating it can force users to relink.

### `PLEX_URL`

Where the **container** reaches Plex. `http://192.168.1.50:32400` or
`http://plex:32400`, never `http://localhost:32400`.

See [Plex Setup](Plex-Setup#setting-plex_url).

### `PLEX_TOKEN`

The server owner's Plex token. Browses the library and starts streams.

See [Plex Setup](Plex-Setup#getting-plex_token).

### `REDIRECT_URI`

Your public HTTPS address, e.g. `https://watch.example.com`. Must match the URL
mapping in the Discord Developer Portal exactly — scheme included, no trailing
slash.

### `ALLOWED_ORIGINS`

Which origins may call the API. Normally identical to `REDIRECT_URI`.

Comma-separated if you genuinely need more than one:
`https://watch.example.com,https://alt.example.com`.

---

## Access control

### `ALLOWED_GUILD_IDS`

Comma-separated Discord server IDs allowed to use this backend. Leave empty to
allow any server the app is installed in.

```env
ALLOWED_GUILD_IDS=123456789012345678,987654321098765432
```

Membership is checked against Discord rather than taken on trust, so a user
cannot simply claim to be in an allowed server.

To find a server ID: enable **Developer Mode** in Discord (**Settings →
Advanced**), then right-click the server icon → **Copy Server ID**.

> This is useful alongside a **verified** app, which cannot be made private —
> see [Private or verified?](Discord-Application-Setup#private-or-verified).

### `ADMIN_SECRET`

Optional. A password for one maintenance command,
`DELETE /api/plex/hls/sessions`, which stops every stream the bot has running on
Plex, in every room. Other Plex apps' streams are left alone. It answers with how
many it stopped.

It is for clearing streams stuck in Plex by hand. Nothing calls it on its own,
and the server already stops streams nobody is watching, checking every minute
for ones Plex kept running. Most people can leave it empty.

| `ADMIN_SECRET` | The command is accepted from |
|---|---|
| Empty | Only requests made from inside the container |
| Set | Also anyone sending it in an `X-Admin-Secret` header |

Either way the request needs a signed-in Activity session, like every other
`/api/plex` call. A refused one is answered `403` and logged as
`kill-all refused`.

### `QBT_MANAGER_API_KEY`

Optional shared secret for the private, read-only qBittorrent Manager API. Set
the same value as `THEATER_API_KEY` in `plex-qbt-manager`. Leave unset to disable
the endpoint. See [qBittorrent Manager API](qBittorrent-Manager-API).

---

## Plex extras

### `PLEX_ACCOUNT_TOKEN`

A plex.tv **account** token, as opposed to the **server** token in `PLEX_TOKEN`.

Needed for two things:

- **Plex Discover detail pages.** Without it, searching for a film you do not
  own returns a result whose detail page is blank — the Plex cloud rejects a
  server token.
- **Seerr sign-in.** Requests are made as your Seerr account by authenticating
  with this token, so no Seerr API key is needed.

Falls back to `PLEX_TOKEN` if unset, which will not work for the cloud lookups
above. See [Plex Setup](Plex-Setup#getting-plex_account_token).

### `PLEX_LINK_SECRET`

Encryption key for per-user linked Plex tokens, which are stored encrypted at
rest.

Generate a long random value and **keep it across deployments and backups**:

```bash
openssl rand -hex 32
```

If unset, `DISCORD_CLIENT_SECRET` is used instead — which means rotating that
secret forces every user to relink their Plex account. Setting this explicitly
avoids that coupling.

---

## Video quality

### `VIDEO_BITRATE_KBPS` · `VIDEO_PEAK_BITRATE_KBPS`

Transcode bitrate targets in kbps. Defaults are `12000` average and `20000`
peak. These are what a **re-encoded** stream is made at; a copied one (see
[Direct Stream](#direct_stream)) is the file's own bitrate instead.

**Per-viewer bandwidth scales directly with this**, so it is the main lever if
your upload is tight:

| Setting | Roughly | Good for |
|---|---|---|
| `VIDEO_BITRATE_KBPS=4000` | ~4 Mbps each | Tight upload, or many viewers |
| `VIDEO_BITRATE_KBPS=8000` | ~8 Mbps each | A sensible middle |
| `VIDEO_BITRATE_KBPS=12000` | ~12 Mbps each | Default; good quality |

If your room is bigger than three or four people, the [VPS Relay](VPS-Relay) is
a better answer than dropping quality.

Viewers can also lower their own: **Quality** in the player's settings offers
**Original**, **20**, **12**, **10**, **8** or **4 Mbps** (720p). A lower one gives that viewer a
stream of their own (a copy when the file fits under it, a re-encode at it when
it doesn't), and nobody else's picture changes. After a lot of buffering the
player offers one by itself.

---

## Direct Stream and HEVC

### `DIRECT_STREAM`

Lets Plex copy the original video instead of re-encoding it whenever the player
can decode it: H.264 always, HEVC (10-bit included) when the player says it
can. Audio is still converted to AAC where it has to be. On unless set to `0`;
`0` re-encodes every title.

The picture is the original rather than a re-encode of it, and Plex's
transcoder has almost nothing to do. Some streams are still re-encoded, and
**Stats for nerds** (`I`) says why on its **Playback** row:

| Re-encoded when | Because |
|---|---|
| The subtitle is a picture one (PGS, VobSub), or a text one Plex couldn't read out | It can only be burned into the picture |
| The file averages over `DIRECT_STREAM_MAX_KBPS`, or over the viewer's own quality | Your upload, or theirs |
| The file is an open-GOP Blu-ray H.264 | A copy's segments couldn't start on a clean keyframe |
| The player can't decode the codec | HEVC in Discord on Firefox, for one |
| A copy of the title failed earlier | It stays re-encoded until the server restarts |
| `DIRECT_STREAM` is `0` | Direct Stream is off on the server |

Text subtitles are drawn by each player, so they never stop a copy.

It is decided per viewer: a player that can't decode a copy (an HEVC one) gets
an H.264 stream of its own, the host as much as anyone, and everyone else keeps
the original.

### `DIRECT_STREAM_MAX_KBPS`

The highest **average** bitrate (kbps) a file may have and still be copied.
Unset, it is `VIDEO_BITRATE_KBPS`. Files averaging more are re-encoded at
`VIDEO_BITRATE_KBPS`.

Peaks don't count: a film averaging 18 Mbps that runs past 60 for a few seconds
is copied under a `20000` limit, and the players' buffers carry the peaks.

A copy is the file's own bitrate, and every viewer pulls it from your server: a
30 Mbps remux for two people is up to 60 Mbps of upload. Players on the same
stream share segments with each other once their buffers are full, which helps,
but don't count on it. Keep this under your upload divided by how many usually
watch.

> [!IMPORTANT]
> Plex counts the bot as a remote player unless its network is listed under
> **Settings → Network → LAN Networks**, and then also holds its streams to your
> remote-streaming limits. Plex's log says `(WAN)` next to the bot's requests
> when that is happening. See [Plex Setup](Plex-Setup#let-plex-treat-the-bot-as-local).

### `HEVC_TRANSCODE`

Lets Plex re-encode to HEVC instead of H.264 for players that can decode it,
which looks noticeably better at the same bitrate. On unless set to `0`; `0`
keeps every re-encode H.264.

Needs Plex Pass, hardware encoding (Intel or NVIDIA) and **Enable HEVC video
encoding** in Plex's transcoder settings; without those Plex just keeps sending
H.264. It is per viewer, as Direct Stream is: anyone whose player can't decode
HEVC gets an H.264 stream of their own.

Copying an HEVC file needs only `DIRECT_STREAM`; this setting is about
re-encodes.

---

## Stream caches

The server keeps the films being played, so going back plays from here rather
than loading again.

| Variable | Default | Meaning |
|---|---|---|
| `DIRECT_STREAM_MEMORY_MB` | `6144` | Memory for copied films, every stream together |
| `STREAM_CACHE_DIR` | `stream-cache` in the data folder | Where a copy goes past that memory |
| `TRANSCODE_CACHE_MB` | `2048` | Memory for re-encoded films, every stream together |

A copy is kept until its stream ends: in memory up to `DIRECT_STREAM_MEMORY_MB`,
and the rest on disk with no limit but the disk, which is up to 13.5 GB an hour
for a 30 Mbps Blu-ray. Each stream's folder is deleted when it ends, and the
whole folder when the server starts. Put it on an SSD, since a skip back reads
from it, by mounting one into the container:

```yaml
volumes:
  - app-data:/data
  - /path/to/ssd/theater-stream-cache:/cache/stream
```

```env
STREAM_CACHE_DIR=/cache/stream
```

A re-encode keeps `TRANSCODE_CACHE_MB` in memory, and Plex keeps the rest of it
on its own disk for the whole session, so it needs no disk here.

Together the defaults can use 8 GB of memory while films play. On a server short
of memory, lower both.

---

## Playback engine

Who makes the streams. Unset, Plex does. `PLAYBACK_ENGINE=ffmpeg` has this
container make them, from the files themselves, and leaves to Plex any stream
ffmpeg can't make. It needs the library mounted into the container, a GPU
for re-encodes (`/dev/dri` for Intel or AMD, or NVIDIA's runtime), and room in
`STREAM_CACHE_DIR` for each stream's whole film. [FFmpeg Engine](FFmpeg-Engine)
covers the setup and how to check it.

| Variable | Default | Meaning |
|---|---|---|
| `PLAYBACK_ENGINE` | Plex | `ffmpeg` to make streams in this container |
| `MEDIA_PATH_MAP` | none | `Plex's path=>the path here`, comma-separated, for a library mounted at other paths than Plex's |
| `FFMPEG_HWACCEL` | `auto` | `auto`: Intel Quick Sync, else VAAPI, else the CPU. `qsv`, `vaapi`, `nvenc` or `none` (the CPU) choose |
| `FFMPEG_HWACCEL_DEVICE` | `/dev/dri/renderD128` | The render node Quick Sync and VAAPI run on, or NVENC's GPU number |
| `FFMPEG_HW_DECODE` | on | `off`: the GPU encodes, the CPU decodes |
| `FFMPEG_MAX_ENCODES` | 6 on the GPU, 2 on the CPU | Re-encodes at once, past which Plex makes the stream. Copies don't count |
| `FFMPEG_PRESET` | each encoder's own | `ultrafast` to `veryslow`: the encoder's speed against quality |
| `FFMPEG_LOOKAHEAD` | the whole film | Seconds each run is held ahead of the room; unset, the whole film is made ahead |
| `FFMPEG_AUDIO_CHANNELS` | 6 | Surround the player can't play becomes 5.1 AAC; `2`: stereo, as Plex makes it |
| `FFMPEG_PGS` | on | `off`: PGS subtitles are burned into a re-encode instead of drawn by each player |
| `FFMPEG_SUBTITLES` | on | `off`: text subtitles are read by Plex, not out of the file here |
| `FFMPEG_PREVIEWS` | on | `off`: no seek-bar previews made for files Plex has none for |
| `FFMPEG_PREVIEWS_MAX_GB` | 20 | Room for those previews; the least recently used go past it |
| `FFMPEG_SEGMENT_MEMORY_MB` | 512 | Memory for the segments rooms are fetching now; `0` reads them from disk |
| `FFMPEG_FALLBACK_TO_PLEX` | on | `off`: a stream ffmpeg can't make fails to start instead of going to Plex |
| `FFMPEG_HDR_REENCODE` | `keep` | `keep`: HDR stays HDR, copied or in HEVC Main10, for HEVC players (for a screen in SDR, see `FFMPEG_HDR_ON_SDR`). `tonemap`: re-encodes always mapped to SDR |
| `FFMPEG_HDR_ON_SDR` | `browser` | HDR for a screen in SDR. `browser`: HDR10 and Dolby Vision 7 and 8.1 in HEVC sent as they are, labelled `FFMPEG_HDR_ON_SDR_NITS` for the player's own tone map, which shows them brighter. `server`: mapped to SDR from the film's 10 bits here, that viewer on a stream of their own. HLG, Dolby Vision 5 and players without HEVC are always mapped here |
| `FFMPEG_HDR_ON_SDR_NITS` | `200` | The peak HDR for a screen in SDR is labelled, 100 to 1000: lower is brighter, down to 200, and above it is white |
| `FFMPEG_TONEMAP` | `mobius` | The curve for streams mapped to SDR: `mobius` (at 0.5, close to Plex's app for Windows), `reinhard`, `hable`, `bt2390`, `linear`, `gamma` or `clip` |
| `FFMPEG_REPORT_TO_PLEX` | on | Show ffmpeg's streams in Plex's dashboard, Tautulli and Tracearr. `0` turns it off |
| `FFMPEG_PATH` | the image's ffmpeg | Another ffmpeg, for running from source |
| `FFPROBE_PATH` | the ffprobe beside ffmpeg | Its ffprobe |

`DIRECT_STREAM`, `DIRECT_STREAM_MAX_KBPS`, `VIDEO_BITRATE_KBPS` and the stream
caches above apply to ffmpeg's streams as they do to Plex's.

---

## Optional integrations

Each of these is covered in more detail in
[Optional Integrations](Optional-Integrations).

| Variable | Unlocks | Get one from |
|---|---|---|
| `TMDB_API_KEY` | Full collection rows and "More Like This" | [TMDB API settings](https://www.themoviedb.org/settings/api) |
| `TVDB_API_KEY` | Missing-episode lists matching Sonarr's numbering | [TheTVDB API](https://thetvdb.com/api-information) |
| `TVDB_PIN` | Only for a subscriber TVDB key; a free project key needs none | Your TVDB account |
| `SEERR_URL` | The Request button | Your Overseerr / Jellyseerr URL |
| `QBT_MANAGER_API_KEY` | Viewer-aware upload budgets and Discord pause state | Generate a long random secret |

---

## VPS relay

### `VPS_RELAY_URL` · `VPS_RELAY_KEY`

Route video segments through a VPS so your home server only uploads one copy.
Setting these also disables peer-to-peer sharing, since the relay makes it
unnecessary.

Full walkthrough: [VPS Relay](VPS-Relay).

---

## Caching and performance

### `THUMB_CACHE_TTL_MS` · `THUMB_CACHE_MAX_SIZE`

Artwork cache lifetime and size cap. Defaults: 90 days, 10 GB. Raise the cap on
a large library if you see posters reloading, or if the warm-up below reports
that the image cache is full.

`THUMB_CACHE_MAX_SIZE` takes a size with a unit: `500M`, `50G`, `2T`. A bare
number is megabytes. `THUMB_CACHE_MAX_MB`, the older setting, still works and
is read when `THUMB_CACHE_MAX_SIZE` is unset.

### `WARM_CACHE` · `WARM_CACHE_MAX_ITEMS` · `WARM_CACHE_DELAY_MS` · `WARM_CACHE_INTERVAL_MIN` · `WARM_CACHE_ARTWORK` · `WARM_CACHE_EPISODES`

After startup the server walks your library in the background and pre-fetches
what a detail page needs, so opening a title is a cache hit instead of several
round trips while you look at a loading skeleton.

Each pass covers the newest titles, in this order:

1. Their details and related rows.
2. Their posters and backgrounds, then their first 12 cast photos, then the
   posters in their collection and "More Like This" rows.
3. For every show among them: each season's list of missing and upcoming
   episodes (when TVDB or TMDB is set up), every episode's details, season
   posters, episode stills, and each episode's first 12 cast photos.

Images are fetched at the size the pages ask for, so they're served straight
from the image cache.

The caches are kept in the data volume, so restarts and updates reuse them.
Only what changed in Plex is refreshed, plus anything over a week old, and
images already cached are skipped. The first pass on a large library can take
several hours; later passes are quick.

It is deliberately slow — one request at a time with a pause after each — so it
stays off the critical path of a server that is also transcoding video. Nothing
is asked of Plex while a room is playing, and images stop for the pass once the
image cache is 90% full, so the warm-up never pushes out images people opened.

| Variable | Default | Meaning |
|---|---|---|
| `WARM_CACHE` | `1` | `0` turns it off entirely |
| `WARM_CACHE_MAX_ITEMS` | `600` | Titles to keep warm, newest first, or `all` |
| `WARM_CACHE_DELAY_MS` | `250` | Pause after each request to Plex; raise to tread lighter |
| `WARM_CACHE_INTERVAL_MIN` | `240` | How often to refresh the warmed set |
| `WARM_CACHE_ARTWORK` | `1` | `0` leaves images to load when a page first shows them |
| `WARM_CACHE_EPISODES` | `1` | `0` skips seasons and episodes |

With `WARM_CACHE_MAX_ITEMS=all` on a large library, raise
`THUMB_CACHE_MAX_SIZE` too, or the artwork will stop at the cache limit.

On a small or underpowered server, `WARM_CACHE=0` is a reasonable choice.

### `SUBTITLE_PREFETCH`

The server has Plex read a title's text subtitles out of the file before anyone
picks them, so switching to one is instant: up to three, the one a viewer would
start on and others in its language. Sidecar files are fetched at once.

Each read of a subtitle inside the file is Plex going through the whole file,
which keeps slow disks busy. `0` turns reading ahead off; a subtitle inside the
file is then read when it is first chosen, with a wait while Plex reads it. On
unless set to `0`.

---

## Logging

Everything the server logs goes to `<data>/logs/theater-YYYY-MM-DD.log`.
Connected clients also ship their player events into the same file, so a stream
that died can be reconstructed after the container logs have rolled away.

**Plex and session tokens are redacted automatically.**

| Variable | Default | Meaning |
|---|---|---|
| `LOG_TO_FILE` | `1` | `0` for console only |
| `LOG_DIR` | `/app/data/logs` | Where files are written |
| `LOG_RETENTION_DAYS` | `7` | Days to keep |
| `LOG_MAX_FILE_MB` | `64` | Rotate at this size |
| `DEBUG` | unset | Verbose per-request logging |

Copy logs out of the container:

```bash
docker cp plex-discord-theater:/data/logs ./logs
```

> [!NOTE]
> `DEBUG=1` logs a line for every video segment, keep-alive ping and prefetch
> poll — roughly five times the volume, and one evening's viewing produced
> around 6,700 segment lines. Turn it on to investigate a specific problem, then
> turn it off.

---

## Server

### `PORT`

Port the server listens on inside the container. Default `3000`. Change the
published port in `docker-compose.yml` rather than this, in most cases.

---

## Next

→ [Optional Integrations](Optional-Integrations) · [Troubleshooting](Troubleshooting)
