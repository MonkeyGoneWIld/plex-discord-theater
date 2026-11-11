# Configuration Reference

Every setting the server reads, grouped by purpose, with its default. Only the
six required settings must be set; everything else has a working default or
turns an optional feature on.

## How to set a value

| Installed with | Where settings go | Format |
|---|---|---|
| The published image | `environment:` in the compose file | `KEY: "value"` |
| Built from source | `.env` next to `docker-compose.yml` | `KEY=value`, without quotes or spaces around `=` |

Apply a change by recreating the container:

```bash
docker compose up -d
```

Settings that are on by default turn off with `0`. The FFmpeg engine's
switches, and `STYLED_SUBTITLES`, also accept `off`, `false` or `no`.

---

## Required

The server doesn't start without these.

| Setting | Value |
|---|---|
| `DISCORD_CLIENT_ID` | The Application ID from the Discord Developer Portal. Not secret: it is sent to every viewer's browser. |
| `DISCORD_CLIENT_SECRET` | The Client Secret from **OAuth2**. Secret. |
| `PLEX_URL` | Plex's address as the container reaches it, for example `http://192.168.1.50:32400`. Never `localhost`. See [Plex Setup](Plex-Setup#choose-plex_url). |
| `PLEX_TOKEN` | The Plex server owner's token. See [Plex Setup](Plex-Setup#get-plex_token). |
| `REDIRECT_URI` | Your public HTTPS address, for example `https://watch.example.com`, without a trailing slash. It must match the URL mapping in the Discord Developer Portal. |
| `ALLOWED_ORIGINS` | The addresses allowed to call the server, normally the same as `REDIRECT_URI`. Separate several with commas. |

## Plex accounts

| Setting | Default | Description |
|---|---|---|
| `PLEX_ACCOUNT_TOKEN` | `PLEX_TOKEN` | The owner's plex.tv account token. Needed for pages of titles outside your library (Plex Discover) and for Seerr requests; `PLEX_TOKEN` doesn't work for either. See [Plex Setup](Plex-Setup#get-plex_account_token). |
| `PLEX_LINK_SECRET` | `DISCORD_CLIENT_SECRET` | The key that encrypts viewers' linked Plex accounts. Set it before anyone links an account, and keep it: changing it, or changing `DISCORD_CLIENT_SECRET` while this is unset, means everyone links again. Generate one with `openssl rand -hex 32`. |

## Access and security

| Setting | Default | Description |
|---|---|---|
| `ALLOWED_GUILD_IDS` | Any server | Discord server IDs allowed to use the Activity, separated by commas. Membership is checked with Discord. While it is set, launches from DMs are refused. |
| `HOST_REQUESTS` | On | Lets anyone ask an away host for the host role, which passes to them if the host doesn't answer. See [Roles and Permissions](Roles-and-Permissions). `off` turns it off. |
| `ADMIN_SECRET` | None | Password for the maintenance command `DELETE /api/plex/hls/sessions`, which stops every stream the server has running in Plex. The request needs a signed-in session. Without this setting it is accepted only from inside the container; with it, also from requests carrying an `X-Admin-Secret` header. Most installations leave it empty. It is not the admin page's password: see `ADMIN_PASSWORD`. |
| `QBT_MANAGER_API_KEY` | None | Turns on the read-only API for plex-qbt-manager. Use the same value as its `THEATER_API_KEY`. See [qBittorrent Manager API](qBittorrent-Manager-API). |

To find a Discord server ID, turn on **Developer Mode** in Discord under
**Settings → Advanced**, then right-click the server icon and select **Copy
Server ID**.

## Streaming

How streams are made and how much each viewer downloads. See
[Streaming and Quality](Streaming-and-Quality) for how these work together.

| Setting | Default | Description |
|---|---|---|
| `VIDEO_BITRATE_KBPS` | `20000` | Average bitrate of a re-encode, in kbps. Each viewer of a re-encoded stream downloads about this much. |
| `VIDEO_PEAK_BITRATE_KBPS` | `33000`, or `VIDEO_BITRATE_KBPS` if higher | Peak bitrate of a re-encode. A re-encode's peak is never below its average. |
| `DIRECT_STREAM` | On | Copies the original video when the player can decode it. `0` re-encodes every title. |
| `DIRECT_STREAM_MAX_KBPS` | `25000`, or `VIDEO_BITRATE_KBPS` if higher | The highest average bitrate a file may have and still be copied. Larger files are re-encoded. |
| `HEVC_TRANSCODE` | On | Re-encodes to HEVC for players that decode it. With the Plex engine this needs Plex Pass and hardware HEVC encoding. `0` keeps every re-encode H.264. |
| `AV1_TRANSCODE` | On | FFmpeg engine only: re-encodes to AV1 for players that decode it in hardware, when the GPU encodes AV1. `0` turns it off. |

## Stream caches

The server keeps the films being played, so seeking back plays at once.

| Setting | Default | Description |
|---|---|---|
| `DIRECT_STREAM_MEMORY_MB` | `6144` | Memory for copied video, all streams together. A copy beyond it continues on disk. |
| `STREAM_CACHE_DIR` | `/data/stream-cache` | Where copies beyond that memory, and the FFmpeg engine's streams, are written. Each stream's folder is deleted when the stream ends, and the whole folder is emptied when the server starts, so give it a folder of its own. |
| `TRANSCODE_CACHE_MB` | `2048` | Memory for re-encoded video, all streams together. Plex keeps the rest of a re-encode on its own disk. |

Together, the defaults can use 8 GB of memory while films play. On a server
with less memory, lower both values.

A copy is kept until its stream ends, so its disk use grows to the size of the
part watched: up to about 11 GB per hour at the 25 Mbps copy limit. Seeking
back reads from this folder, so an SSD helps. To use one, mount it and point
`STREAM_CACHE_DIR` at it:

```yaml
    volumes:
      - app-data:/data
      - /path/to/ssd/theater-stream-cache:/cache/stream
    environment:
      STREAM_CACHE_DIR: "/cache/stream"
```

## Playback engine

`PLAYBACK_ENGINE=ffmpeg` has the container make the streams itself. Each
setting below is explained in [FFmpeg Engine](FFmpeg-Engine#settings).

| Setting | Default | Description |
|---|---|---|
| `PLAYBACK_ENGINE` | Plex | `ffmpeg` to make streams in this container |
| `MEDIA_PATH_MAP` | None | `Plex's path=>path in this container`, separated by commas, when the library is mounted at other paths than Plex's |
| `FFMPEG_HWACCEL` | `auto` | `auto`, `qsv`, `vaapi`, `nvenc`, or `none` for the CPU |
| `FFMPEG_HWACCEL_DEVICE` | `/dev/dri/renderD128` | The render node for Quick Sync and VAAPI, or the GPU number for NVENC |
| `FFMPEG_HW_DECODE` | On | `off`: the GPU encodes and the CPU decodes |
| `FFMPEG_MAX_ENCODES` | 6 on a GPU, 2 on the CPU | Re-encodes at once. Beyond it, Plex makes the stream. Copies don't count. |
| `FFMPEG_PRESET` | Each encoder's own | `ultrafast` to `veryslow`: speed against quality |
| `FFMPEG_LOOKAHEAD` | The whole film | Seconds each stream is made ahead of the room |
| `FFMPEG_AUDIO_CHANNELS` | `6` (5.1) | `2`: surround sound the player can't play becomes stereo instead of 5.1 |
| `FFMPEG_SUBTITLES` | On | `off`: Plex reads text subtitles instead of the engine |
| `FFMPEG_PGS` | On | `off`: PGS subtitles are burned into a re-encode instead of drawn by each player |
| `FFMPEG_PGS_MAX_GB` | `2` | Disk kept for PGS subtitles cut out of films; the least recently used go first |
| `FFMPEG_PREVIEWS` | On | `off`: no seek-bar previews for files Plex has none for |
| `FFMPEG_PREVIEWS_MAX_GB` | `20` | Disk kept for those previews; the least recently used go first |
| `FFMPEG_SEGMENT_MEMORY_MB` | `512` | Memory for the segments rooms are fetching now. `0` reads each from disk. |
| `FFMPEG_FALLBACK_TO_PLEX` | On | `off`: a stream the engine can't make fails instead of going to Plex. For testing. |
| `FFMPEG_HDR_REENCODE` | `keep` | `keep`: re-encodes stay HDR for players that decode HEVC. `tonemap`: always mapped to SDR. |
| `FFMPEG_HDR_ON_SDR` | `browser` | HDR on a screen in SDR: `browser` lets the player map it; `server` maps it to SDR in the container |
| `FFMPEG_HDR_ON_SDR_NITS` | `200` | The peak brightness HDR is labelled with for a screen in SDR, 100 to 1000 |
| `FFMPEG_TONEMAP` | `mobius` | The curve used to map HDR to SDR: `mobius`, `reinhard`, `hable`, `bt2390`, `linear`, `gamma` or `clip` |
| `FFMPEG_REPORT_TO_PLEX` | On | Shows the engine's streams in Plex's dashboard, Tautulli and Tracearr. `0` turns it off. |
| `FFMPEG_PATH` | The image's ffmpeg | Another ffmpeg binary, when running from source |
| `FFPROBE_PATH` | The ffprobe beside `FFMPEG_PATH` | Another ffprobe binary |

`DIRECT_STREAM`, `DIRECT_STREAM_MAX_KBPS`, `VIDEO_BITRATE_KBPS` and the stream
caches apply to both engines.

## Subtitles

| Setting | Default | Description |
|---|---|---|
| `SUBTITLE_PREFETCH` | On | Reads a title's text subtitles ahead, so switching to one is immediate: up to three, starting with the one a viewer would start on. Each read of a subtitle inside a file makes Plex read the whole file, so `0` turns this off on slow disks; a subtitle is then read when first chosen. |
| `STYLED_SUBTITLES` | On | Draws ASS subtitles with their own styling. `off` draws them as plain lines in each viewer's chosen look. |

## Integrations

| Setting | Default | Description |
|---|---|---|
| `TMDB_API_KEY` | None | Collections, **More Like This** and cast pages. See [Optional Integrations](Optional-Integrations#tmdb). |
| `TVDB_API_KEY` | None | Missing-episode lists numbered as Sonarr numbers them. See [Optional Integrations](Optional-Integrations#tvdb). |
| `TVDB_PIN` | None | Only for a TVDB subscriber key |
| `SEERR_URL` | None | The address of Overseerr or Jellyseerr, for the **Request** button. See [Requesting Titles](Requesting-Titles). |

## Caching and performance

| Setting | Default | Description |
|---|---|---|
| `THUMB_CACHE_DIR` | Set to `/data` in the compose file | The data folder: databases, caches, logs and the stream cache. Keep it at the volume's mount point. |
| `THUMB_CACHE_TTL_MS` | 90 days | How long cached artwork is kept, in milliseconds |
| `THUMB_CACHE_MAX_SIZE` | `10G` | Size limit of the artwork cache, with a unit (`500M`, `50G`, `2T`); a bare number is megabytes. The older `THUMB_CACHE_MAX_MB` is read when this is unset. |
| `WARM_CACHE` | On | Prepares title pages in the background. `0` turns it off. |
| `WARM_CACHE_MAX_ITEMS` | `600` | Titles to keep prepared, newest first, or `all` |
| `WARM_CACHE_DELAY_MS` | `250` | Pause after each request to Plex |
| `WARM_CACHE_INTERVAL_MIN` | `240` | Minutes between passes |
| `WARM_CACHE_ARTWORK` | On | `0` leaves artwork to load when a page first shows it |
| `WARM_CACHE_EPISODES` | On | `0` skips seasons and episodes |

### The background warm-up

A short while after the server starts, it prepares what title pages need for
your newest titles, so opening one is immediate: details and related rows,
posters, backgrounds and cast photos, and for shows, every season's episodes
and missing-episode list. Later passes refresh only what changed in Plex and
anything older than a week.

It sends one request at a time with a pause after each, and it pauses while a
room is playing. It stops adding artwork when the artwork cache is 90% full,
so it never pushes out artwork people opened. The first pass on a large library
can take several hours. With `WARM_CACHE_MAX_ITEMS=all` on a large library,
raise `THUMB_CACHE_MAX_SIZE` as well. On a small server, `WARM_CACHE=0` is a
reasonable choice.

## Admin page

See [Admin Page](Admin-Page).

| Setting | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | None | Turns the admin page and its history on, and is its password. Use 12 characters or more. |
| `ADMIN_PORT` | `3050` | The admin page's port. It can't be `PORT`. Publish it in the compose file's `ports:`. |
| `ADMIN_HOST` | `0.0.0.0` | The address it listens on inside the container. |

## Logging

The server writes its log, and the player events of every viewer, to
`/data/logs/theater-YYYY-MM-DD.log`. Tokens and keys are removed from the file.

| Setting | Default | Description |
|---|---|---|
| `LOG_TO_FILE` | On | `0` logs to the console only |
| `LOG_DIR` | `/data/logs` | Where log files are written |
| `LOG_RETENTION_DAYS` | `7` | Days of logs to keep |
| `LOG_MAX_FILE_MB` | `64` | Size at which a day's file continues in a new one |
| `DEBUG` | Off | `1` logs every request in detail, about five times the volume. Use it while investigating a problem, then turn it off. |

To copy the logs out of the container:

```bash
docker cp plex-discord-theater:/data/logs ./logs
```

## Server

| Setting | Default | Description |
|---|---|---|
| `PORT` | `3000` | The port the server listens on inside the container. To use another port on the host, change the compose file's `ports:` mapping instead. |
