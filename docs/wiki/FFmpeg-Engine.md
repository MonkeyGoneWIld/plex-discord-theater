# FFmpeg Engine

By default, Plex makes the streams the Activity plays. With
`PLAYBACK_ENGINE=ffmpeg`, the container makes them itself, with its own FFmpeg,
straight from your files. Plex still provides the library, the metadata and
the watch history, and still makes any stream the engine can't.

The engine is optional. The image is the same either way, so switching is one
setting and a restart.

## Plex engine or FFmpeg engine?

| | Plex engine (default) | FFmpeg engine |
|---|---|---|
| Setup | Nothing extra | Mount your library into the container, and map a GPU for transcodes |
| Sent unchanged | H.264 and HEVC | H.264, HEVC, AV1 and VP9, plus Blu-ray H.264 with open GOPs |
| Audio sent unchanged | AAC | Also Opus, FLAC, AC3 and EAC3, for devices that play them |
| Blu-ray and DVD subtitles (PGS, VobSub, DVB) | Burned in, which forces a transcode | Drawn by each player, so the video stays unchanged |
| HDR in a transcode | Mapped to SDR | Kept as HDR10 |
| Dolby Vision profile 5 | Wrong colours in a browser | Correct colours |
| Seeking | Can restart the stream | The whole film is made ahead, so seeks play at once |
| Seek-bar previews | Only where Plex has generated them | Made for any file that has none |
| A device that drops frames | Stays on the same stream | Moves to a lighter stream of its own |
| Transcodes run on | Plex's transcoder (Plex Pass for hardware) | This container: Intel Quick Sync, VAAPI or NVIDIA NVENC |

## Requirements

| You need | Details |
|---|---|
| Your library, mounted read-only | At the path Plex uses, or mapped with [`MEDIA_PATH_MAP`](#2-map-the-library-paths). Without the mount, FFmpeg reads each file from Plex over the network, which works but makes seeks slower. |
| A GPU, for transcodes | `/dev/dri` for Intel Quick Sync or VAAPI, or the NVIDIA Container Toolkit for NVENC. Without a GPU, transcodes are H.264 on the CPU. Video sent unchanged needs no GPU. |
| Disk space for streams | Each stream's film is written to `STREAM_CACHE_DIR` and kept until the stream ends. At the default limits, allow about 11 GB per hour of film. `FFMPEG_LOOKAHEAD` limits how far ahead each stream is made. |
| Plex, set up as usual | For the library, and for the streams the engine leaves to Plex. Keep [Plex's transcoder](Plex-Setup#transcoder) working. |

The image includes Jellyfin's build of FFmpeg, Intel's media and OpenCL
drivers, and subtitle fonts, so nothing needs installing. Intel Quick Sync is
the most tested setup. VAAPI on AMD and NVIDIA NVENC are supported and less
tested.

## Set it up

### 1. Mount the library and the GPU

Add your library and GPU to the compose file, and turn the engine on:

```yaml
services:
  plex-discord-theater:
    image: ghcr.io/monkeygonewild/plex-discord-theater:latest
    devices:
      - /dev/dri:/dev/dri
    volumes:
      - app-data:/data
      - /mnt/media:/data/media:ro
    environment:
      PLAYBACK_ENGINE: "ffmpeg"
      # ...the other settings from Installation
```

The container's user is added to the groups of `/dev/dri` at startup, so no
`group_add` is needed. If Docker runs inside a Proxmox LXC container or a
virtual machine, pass the GPU through to it first.

For NVIDIA, install the NVIDIA Container Toolkit on the host and use this
instead of `devices`:

```yaml
    runtime: nvidia
    environment:
      NVIDIA_VISIBLE_DEVICES: "all"
      NVIDIA_DRIVER_CAPABILITIES: "compute,video,utility"
      FFMPEG_HWACCEL: "nvenc"
```

### 2. Map the library paths

FFmpeg opens each file at the path Plex reports for it. If Plex sees the
library at different paths than this container does, map each of Plex's paths
to the path here:

```env
MEDIA_PATH_MAP=/media/movies=>/data/media/movies,/media/tv=>/data/media/tv
```

Each pair is `Plex's path=>path in this container`. The first pair that
matches is used. If both containers use the same paths, leave `MEDIA_PATH_MAP`
unset.

To check every library:

```bash
docker exec -it plex-discord-theater node scripts/diagnose-ffmpeg.mjs paths
```

It samples titles from each library, reports which it can read, and suggests a
map for any it can't. The server also runs a quick check at every start:

```text
[Config] library on the mount: Movies 10/10 readable, TV Shows 10/10 readable
```

Files that can't be read on the mount are read through Plex instead.

### 3. Restart and check

```bash
docker compose up -d
docker compose logs plex-discord-theater | grep 'playback engine'
```

## Check that it works

### The startup line

```text
[Config] playback engine: ffmpeg — ffmpeg version 8.1.3-Jellyfin …; copies H.264 and HEVC files itself, HDR included; re-encodes on Intel QSV (HEVC Main10 and H.264), tone mapping mobius on OpenCL, …
```

At startup the engine runs a short test encode on the GPU and reports the
result:

| The line says | Meaning |
|---|---|
| `re-encodes on Intel QSV …, tone mapping … on OpenCL` | Everything works |
| `re-encodes on VAAPI …` or `NVIDIA NVENC …` | The GPU you named, or the one `auto` found |
| `… (OpenCL didn't: …; Dolby Vision 5 goes to Plex)` | Transcodes run on the GPU, but Dolby Vision 5 titles are left to Plex |
| `CPU (no /dev/dri/renderD128; /dev/dri has: …)` | The GPU isn't mapped into the container. It is looked for again before each transcode, so mapping it in later works without a restart. |
| `CPU (Intel QSV didn't encode: …)` | The GPU is there, but the test encode failed. See [Troubleshooting](Troubleshooting#transcodes-run-on-the-cpu). |
| `ffmpeg wanted … but not found` | Every stream goes to Plex. Check `FFMPEG_PATH`, or update the image. |

### Each stream

- In the player, **Stats for nerds** (**I**) has an **Engine** row: `ffmpeg`
  with what encodes and decodes the stream, or `Plex`. For a stream the engine
  left to Plex, it shows the reason in amber.
- The [Dashboard](Dashboard) shows each stream's engine, source, output and
  reason.
- The server log has one line per stream. `source=plex` on it means the file
  couldn't be read at its mapped path, and FFmpeg read it from Plex over the
  network.

```text
[FFmpeg] copying session=… ratingKey=… source=mount …
[FFmpeg] re-encoding session=… ratingKey=… source=mount …
```

### GPU use

Each transcode logs how much GPU and CPU its FFmpeg process used:

```text
[FFmpeg] run stopped session=… gpu=video 34%, render 12%, video-enhance 0%, copy 0% over 61.2 s (i915, /dev/dri/renderD128) cpu=0.4 cores read=9 Mbps
```

`gpu=none` means the CPU did the work. This line is more reliable than
`intel_gpu_top` on the host, which can show the GPU idle while it encodes.

### Diagnosis commands

```bash
docker exec -it plex-discord-theater node scripts/diagnose-ffmpeg.mjs <command>
```

| Command | Checks |
|---|---|
| `gpu` | The FFmpeg build, `/dev/dri` and its permissions, VAAPI, OpenCL, and test encodes |
| `paths` | Whether each library's files can be read on the mount |
| `file --rating-key <id>` | One title end to end: what the engine and Plex would each do with it |
| `rate --rating-key <id>` | Rate-control modes compared on one title |
| `plex-visibility --rating-key <id>` | Whether the engine's streams appear in Plex's dashboard |
| `all` | Every check |

Reports are written to `/data/diagnose`. `--help` lists every option.

## How the engine handles your files

### Video and audio

- **Sent unchanged** for devices that play them: H.264, HEVC, AV1 and VP9, 4K
  and HDR10, HLG and Dolby Vision 7 and 8 included.
- **10-bit H.264** is always transcoded, because Discord's player doesn't play
  it.
- **Audio** in Opus, FLAC, AC3 or EAC3 is sent unchanged to devices that play
  it. Surround audio a device can't play becomes 5.1 AAC (or stereo with
  `FFMPEG_AUDIO_CHANNELS=2`). 7.1 becomes Opus 7.1, and PCM becomes FLAC.
- **Transcodes** are made at about the source's own bitrate, adjusted for the
  codec, never above `VIDEO_BITRATE_KBPS` or the viewer's quality.
- **The whole film is made ahead**, as fast as the hardware allows, and kept
  until the stream ends. A seek anywhere plays without a restart.

### Subtitles

| Subtitle | What happens |
|---|---|
| Text subtitles in the file (SRT, ASS, WebVTT) | Read from the file and drawn by each player. `FFMPEG_SUBTITLES=off` leaves reading them to Plex. |
| Picture subtitles in the file (PGS, VobSub, DVB) | Cut out of the film once, and drawn by each player over the picture. The video stays unchanged. `FFMPEG_PGS=off` burns them in instead. `FFMPEG_PGS_MAX_GB` (2 by default) limits the disk they use. |
| Subtitles that must be burned in (a VobSub file beside the film, or a text subtitle a player can't draw) | Drawn by FFmpeg in a transcode, with the film's own fonts for text |

### Seek-bar previews

Plex makes preview thumbnails only for libraries with **Generate video preview
thumbnails** on, and only once its scheduled task has reached a file. For a
file without them, the engine makes them the first time someone opens the
title: one small frame every 10 seconds, at the lowest CPU priority, one file
at a time.

Previews are kept in the data folder, so each file is done once. The first
viewer of a long film may see them arrive a minute or two in.
`FFMPEG_PREVIEWS=off` turns this off, and `FFMPEG_PREVIEWS_MAX_GB` (20 by
default) limits the folder's size.

### HDR

| Stream | Result |
|---|---|
| Video sent unchanged, to a screen in HDR | Kept as it is |
| A transcode for a device that plays HEVC, on a screen in HDR | Kept as HDR10. `FFMPEG_HDR_REENCODE=tonemap` maps it to SDR instead. |
| HDR10 or Dolby Vision 7 or 8.1, on a screen in SDR | The same stream as for HDR screens, labelled so the browser maps it well. See below. |
| HLG on a screen in SDR, or `FFMPEG_HDR_ON_SDR=server` | Mapped to SDR in the container |
| H.264, for a device that can't play HEVC | Mapped to SDR |
| A burned-in subtitle | Mapped to SDR, so the subtitle isn't too bright |
| Dolby Vision 5 | Mapped to SDR with its metadata applied, so the colours are right |
| Dolby Vision 8.2 and 10.2 | Played as the SDR picture they carry |

Mapping to SDR uses the curve in `FFMPEG_TONEMAP`. The default, `mobius`, is
the closest match to Plex's own apps.

#### HDR on a screen in SDR

Chrome, and so Discord, maps HDR to an SDR screen itself, using the peak
brightness the stream declares. At a film's real peak, most films look too
dark that way.

For a screen in SDR, the engine labels the stream with a lower peak,
`FFMPEG_HDR_ON_SDR_NITS` (200 by default). Only the stream's header differs,
so screens in HDR and in SDR still share the same video. Values below 200 look
the same as 200. Higher values look darker.

`FFMPEG_HDR_ON_SDR=server` maps HDR to SDR in the container instead, and gives
that viewer a stream of their own.

When a screen changes mid-film (HDR turned on or off, or the window moved to
another screen), the player adapts and continues where it was.

### Smooth playback on every device

Each player counts the frames it drops. A player that keeps dropping 5% or
more for eight seconds of playback is moved, on its own, onto a lighter
version of the same film, one step at a time:

| Dropping frames on | Moves to |
|---|---|
| AV1 | HEVC |
| HEVC, 10-bit | HEVC, 8-bit |
| HEVC, 8-bit | H.264 |

The device remembers this and starts on the lighter version next time. Checks
are skipped while the Activity is hidden, resized, paused or seeking, so a
busy computer or a single burst of dropped frames never moves anyone.

If a device's video decoder stops altogether, the player moves to a stream
without that codec. If the picture is still stuck on H.264, it tells the
viewer to quit Discord fully and open it again, because the decoder belongs to
Discord.

## When a stream goes to Plex

The engine makes what it can and leaves the rest to Plex, one stream at a
time. Other viewers in the room stay on the engine. The log gives the reason
on a `[FFmpeg] … left to Plex` line, and Stats for nerds shows it.

| Left to Plex when | Why |
|---|---|
| A text subtitle in the file must be burned in, and its text hasn't been read yet | FFmpeg needs the whole text. It is read in the meantime, so the next start uses the engine. |
| A picture subtitle beside the film (`.sup`, `.idx`) isn't found on the mount | FFmpeg needs the file. It is found when exactly one file in the film's folder is named after the film with the subtitle's language, such as `Film (2001).en.forced.sup`. |
| Dolby Vision 5 without OpenCL | Only OpenCL applies its metadata. Without it the colours would be wrong. |
| Every transcode slot is taken | `FFMPEG_MAX_ENCODES`. Video sent unchanged doesn't take a slot. |
| The file on disk isn't the size Plex has for it | The file was replaced since Plex last scanned it. The stream stays with Plex until it rescans. |
| The file's tracks aren't the ones Plex lists | Checked before each file's first start, so a track choice can't pick the wrong track |
| Neither the mount nor Plex gives FFmpeg the file | Plex can still read it |
| FFmpeg failed on the title twice within 15 minutes | It goes to Plex until 15 minutes after the last failure |

To make these fail instead of going to Plex, for testing, set
`FFMPEG_FALLBACK_TO_PLEX=off`.

## Plex dashboard, Tautulli and Tracearr

Plex doesn't know about streams it isn't making, so the server reports them to
Plex the way players that play files directly do. The engine's streams appear
in Plex's dashboard, and so in Tautulli and Tracearr.

- They are listed under `PLEX_TOKEN`'s account, and watch progress is saved on
  that account.
- Plex labels them **Direct Play** at the file's own bitrate, because it can't
  know about the engine's transcode.
- Plex and Tautulli can't stop them. Stop them from the Activity.
- A room is one entry, however many streams it makes of the title. The
  [Dashboard](Dashboard) shows each stream separately.

`FFMPEG_REPORT_TO_PLEX=0` turns this off.

## Bandwidth and the qBittorrent manager

Plex lists the engine's streams without a bandwidth, so the server gives the
[qBittorrent manager](qBittorrent-Manager-API) its own figure for each stream:
the file's average for video sent unchanged, and the video target plus the
audio for a transcode.

## Settings

All are optional except `PLAYBACK_ENGINE`. An empty value means the default.
The switches turn off with `off` or `0`.

| Setting | Default | Description |
|---|---|---|
| `PLAYBACK_ENGINE` | `plex` | `ffmpeg` has this container make the streams |
| `MEDIA_PATH_MAP` | Empty | `Plex's path=>path here`, comma-separated, for a library mounted at other paths than Plex's |
| `FFMPEG_HWACCEL` | `auto` | What transcodes run on: `auto` (Quick Sync, then VAAPI, then the CPU), `qsv`, `vaapi`, `nvenc` or `none` (the CPU) |
| `FFMPEG_HWACCEL_DEVICE` | `/dev/dri/renderD128` | The render node for `qsv` and `vaapi`, or the GPU's number for `nvenc` |
| `FFMPEG_HW_DECODE` | On | `off` keeps encoding on the GPU but decodes on the CPU, for a GPU whose decoder fails on some files |
| `FFMPEG_MAX_ENCODES` | 6 on a GPU, 2 on the CPU | How many transcodes run at once. Beyond it, Plex makes the stream. |
| `FFMPEG_PRESET` | The encoder's own | Speed against quality: `ultrafast` to `veryslow`. NVENC takes `p1` to `p7`. VAAPI has no presets. |
| `FFMPEG_LOOKAHEAD` | Empty (the whole film) | Seconds each stream is kept ahead of the room. Uses less disk and GPU time, but seeks past what is made take longer. |
| `FFMPEG_AUDIO_CHANNELS` | `6` | `2` makes surround audio a device can't play stereo, as Plex does |
| `FFMPEG_SUBTITLES` | On | `off` leaves reading text subtitles to Plex |
| `FFMPEG_PGS` | On | `off` burns picture subtitles in |
| `FFMPEG_PGS_MAX_GB` | `2` | Disk for picture subtitles cut out of films |
| `FFMPEG_PREVIEWS` | On | `off` stops making seek-bar previews |
| `FFMPEG_PREVIEWS_MAX_GB` | `20` | Disk for previews. Past it, the least recently used are removed. |
| `FFMPEG_SEGMENT_MEMORY_MB` | `512` | Memory for the video pieces rooms are fetching now. `0` reads every piece from disk. |
| `FFMPEG_HDR_REENCODE` | `keep` | `tonemap` maps HDR to SDR in every transcode |
| `FFMPEG_TONEMAP` | `mobius` | The curve: `mobius`, `reinhard`, `hable`, `bt2390`, `linear`, `gamma` or `clip` |
| `FFMPEG_HDR_ON_SDR` | `browser` | `server` maps HDR to SDR in the container for screens in SDR |
| `FFMPEG_HDR_ON_SDR_NITS` | `200` | The peak an HDR stream is labelled with for a screen in SDR, 100 to 1000 |
| `FFMPEG_REPORT_TO_PLEX` | On | `0` stops reporting the engine's streams to Plex |
| `FFMPEG_FALLBACK_TO_PLEX` | On | `off` makes a stream the engine can't make fail with the reason. For testing. |
| `FFMPEG_PATH`, `FFPROBE_PATH` | The image's own | Another FFmpeg, for running from source. Use Jellyfin's build. |

`DIRECT_STREAM`, `DIRECT_STREAM_MAX_KBPS`, `VIDEO_BITRATE_KBPS`,
`AV1_TRANSCODE` and the stream caches apply to the engine's streams as well.
See the [Configuration Reference](Configuration-Reference).

## Switching back to Plex

Remove `PLAYBACK_ENGINE`, or set it to `plex`, and recreate the container.

## Next

→ [Dashboard](Dashboard) · [Troubleshooting](Troubleshooting#ffmpeg-engine)
