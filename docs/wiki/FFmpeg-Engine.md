# FFmpeg Engine

By default, Plex makes the streams the Activity plays. With
`PLAYBACK_ENGINE=ffmpeg`, the container makes them itself, with its own ffmpeg,
from the files on disk. Plex still provides the library, the metadata and the
watch history, and still makes any stream the engine can't.

The engine is optional. The image is the same either way, so switching is a
setting and a restart.

## What it adds

- **More files copied as they are.** H.264, HEVC and AV1, 4K included, are
  copied for players that decode them, HDR10, HLG and Dolby Vision 7 and 8
  included. Opus, FLAC, AC3 and EAC3 sound is copied for players that play it;
  7.1 sound a browser can't play becomes Opus 7.1, and PCM becomes FLAC.
- **PGS subtitles drawn by the player.** Blu-ray subtitles are cut out of the
  film and drawn by each player, sharp at any size, so a film with them is
  still copied instead of re-encoded to burn them in.
- **HDR kept in re-encodes.** A re-encode for a player that decodes HEVC stays
  HDR10, in HEVC Main10. Plex maps every re-encode to SDR.
- **One HDR stream for every screen.** Screens in HDR and in SDR share the same
  stream, and its segments peer to peer; each player is told how to show it on
  its own screen.
- **A stream for each device.** A player that decodes HEVC but not AV1 gets
  HEVC rather than H.264, and a device that drops frames gets a lighter picture
  of its own. Nobody else's stream changes.
- **Dolby Vision 5 in the right colours.** Re-encoded with its Dolby Vision
  metadata applied, on the GPU through OpenCL. Plex copies it, and browsers
  show it in the wrong colours.
- **Immediate seeks.** Each stream's whole film is made ahead, as fast as the
  hardware allows, and kept until the stream ends, so a seek anywhere plays
  without a restart.
- **Re-encodes at the bitrate the source needs.** A re-encode is made at about
  the source's own bitrate, adjusted for the codec, instead of always at the
  quality limit.
- **Every subtitle can be burned in.** Text subtitles (SRT, and ASS with its
  fonts) and picture subtitles beside the film (`.sup`, VobSub) are drawn by
  ffmpeg when a subtitle must be burned in.
- **Seek-bar previews for every file.** Where Plex has no preview thumbnails,
  the engine makes them.
- **Plex's transcoder stays idle.** The work runs in this container, on the GPU
  when one is mapped in: Intel Quick Sync, VAAPI (AMD or Intel), or NVIDIA
  NVENC.

## Requirements

| Requirement | Details |
|---|---|
| The library, mounted read-only | At the path Plex uses, or mapped with [`MEDIA_PATH_MAP`](#2-map-the-library-paths). Without it, ffmpeg reads each file from Plex over the network, which works but makes seeks slower. |
| A GPU, for re-encodes | `/dev/dri` for Intel Quick Sync or VAAPI, or the NVIDIA Container Toolkit for NVENC. Without one, re-encodes are H.264 on the CPU, and copies are unaffected. |
| Disk space for streams | Each stream's film is written to `STREAM_CACHE_DIR` and kept until the stream ends: a copy takes the size of the file, a re-encode its bitrate times its length. At the default limits, that is up to about 11 GB per hour of film. [`FFMPEG_LOOKAHEAD`](#ffmpeg_lookahead) limits how far ahead each stream is made. |
| Plex, set up as usual | For the library, and for the streams the engine leaves to Plex. Keep [Plex's transcoder](Plex-Setup#transcoder) working. |

The image includes Jellyfin's build of ffmpeg, Intel's media and OpenCL
drivers, and fonts for subtitles, so nothing needs installing. Intel Quick Sync
is the most tested configuration; VAAPI on AMD and NVIDIA NVENC are supported
and less tested.

## Set it up

### 1. Mount the library and the GPU

Add the library and the GPU to the compose file, and turn the engine on:

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

For NVIDIA, install the NVIDIA Container Toolkit on the host, and use this
instead of `devices`:

```yaml
    runtime: nvidia
    environment:
      NVIDIA_VISIBLE_DEVICES: "all"
      NVIDIA_DRIVER_CAPABILITIES: "compute,video,utility"
      FFMPEG_HWACCEL: "nvenc"
```

### 2. Map the library paths

ffmpeg opens each file at the path Plex reports for it: the folder added under
**Settings → Libraries** in Plex. If Plex sees the library at other paths than
this container does, map each of Plex's paths to the path here:

```env
MEDIA_PATH_MAP=/media/movies=>/data/media/movies,/media/tv=>/data/media/tv
```

Each pair is `Plex's path=>path in this container`, and the first pair that
matches is used. If both containers use the same paths, leave
`MEDIA_PATH_MAP` unset.

To check every library, run:

```bash
docker exec -it plex-discord-theater node scripts/diagnose-ffmpeg.mjs paths
```

It samples titles from each library, reports which it can read, and suggests a
map for any it can't. The server runs a quicker check at every start:

```text
[Config] library on the mount: Movies 10/10 readable, TV Shows 10/10 readable
```

A library that isn't fully readable is logged as a warning, with the paths
that weren't found. Files that can't be read on the mount are read through
Plex.

### 3. Restart and check

```bash
docker compose up -d
docker compose logs plex-discord-theater | grep 'playback engine'
```

The next section explains the result.

## Check that it works

### The startup line

```text
[Config] playback engine: ffmpeg — ffmpeg version 8.1.3-Jellyfin …; copies H.264 and HEVC files itself, HDR included; re-encodes on Intel QSV (HEVC Main10 and H.264), tone mapping mobius on OpenCL, subtitles burned in (text ones from their text, with their fonts); 512 MB of segments kept in memory; previews made for files Plex has none for; library at Plex's own paths
```

At startup the engine tries a short HEVC Main10 encode, a short H.264 encode
and a short OpenCL tone map on the GPU. The line reports the result:

| The line says | Meaning |
|---|---|
| `re-encodes on Intel QSV …, tone mapping … on OpenCL` | Everything works. |
| `re-encodes on VAAPI …` or `NVIDIA NVENC …` | The GPU named, or the one `auto` found when Quick Sync didn't work. |
| `… (OpenCL didn't: …; Dolby Vision 5 goes to Plex)` | Re-encodes run on the GPU, but Dolby Vision 5 titles are left to Plex. |
| `CPU (no /dev/dri/renderD128; /dev/dri has: …)` | The GPU isn't mapped into the container. It is looked for again before each re-encode, so mapping it in later works without a restart. |
| `CPU (Intel QSV didn't encode: …)` | The GPU is there, but the test encode failed. See [Troubleshooting](Troubleshooting#re-encodes-run-on-the-cpu). |
| `ffmpeg wanted … but not found` | Every stream goes to Plex. Check `FFMPEG_PATH`, or update the image. |

### Each stream

In the player, **Stats for nerds** (**I**) has an **Engine** row: `ffmpeg` with
what encodes and decodes the stream (for example `ffmpeg · Intel QSV, GPU
decode`), or `Plex`. For a stream the engine left to Plex, it shows the reason
in amber, for example `Plex (ffmpeg: encode slots full (6/6))`. The
**Playback** row says whether the stream is copied or re-encoded, and why.

The server log has one line per stream:

```text
[FFmpeg] copying session=… ratingKey=… source=mount …
[FFmpeg] re-encoding session=… ratingKey=… source=mount …
```

`source=plex` means the file couldn't be read at its mapped path, and ffmpeg
read it from Plex over the network.

### GPU use

Each re-encode logs how much GPU and CPU its ffmpeg used, from the kernel's own
accounting for that process, when it pauses far enough ahead of the room and
again when it stops:

```text
[FFmpeg] run stopped session=… gpu=video 34%, render 12%, video-enhance 0%, copy 0% over 61.2 s (i915, /dev/dri/renderD128) cpu=0.4 cores read=9 Mbps
```

`gpu=none: ffmpeg had no GPU open, so the CPU did the work` means exactly that.
This line is more reliable than `intel_gpu_top` on the host, which can show
the GPU idle while it encodes.

### Diagnosis commands

```bash
docker exec -it plex-discord-theater node scripts/diagnose-ffmpeg.mjs <command>
```

| Command | Checks |
|---|---|
| `gpu` | The ffmpeg build, `/dev/dri` and its permissions, VAAPI, OpenCL, and test encodes |
| `paths` | Whether each library's files can be read on the mount |
| `file --rating-key <id>` | One title end to end: what the engine and Plex would each do with it |
| `rate --rating-key <id>` | Rate-control modes compared on one title |
| `plex-visibility --rating-key <id>` | Whether the engine's streams appear in Plex's dashboard |
| `all` | Every check |

Reports are written to `/data/diagnose`. `--help` lists every option.

## When a stream goes to Plex

The engine makes what it can and leaves the rest to Plex, one stream at a
time. Other viewers in the room stay on the engine. The log gives the reason
on a `[FFmpeg] … left to Plex` line.

| Left to Plex when | Why |
|---|---|
| A text subtitle inside the film must be burned in, and its text hasn't been read yet | ffmpeg needs the whole text to draw it. It is read in the meantime, so the next start, including a seek, uses the engine. The text of an `.mkv` is usually read immediately. |
| A picture subtitle beside the film (`.sup`, `.idx`) isn't found on the mount | ffmpeg needs the file. It is found when exactly one file in the film's folder is named after the film and states the subtitle's language and flags, for example `Film (2001).en.forced.sup`. |
| Dolby Vision 5 without OpenCL | Only OpenCL applies its metadata; without it the colours would be wrong. |
| Every re-encode slot is taken | [`FFMPEG_MAX_ENCODES`](#ffmpeg_max_encodes). Copies don't take a slot. |
| The file on disk isn't the size Plex has for it | The file was replaced since Plex last scanned it. Plex is asked once more, then the stream stays with Plex until it rescans. |
| The file's tracks aren't the ones Plex lists | Checked with `ffprobe` before each file's first start, so an audio or subtitle choice can't pick the wrong track. |
| Neither the mount nor Plex gives ffmpeg the file | Plex can still read it. |
| ffmpeg failed on the title twice within 15 minutes | It goes to Plex until 15 minutes after the last failure. |

To make these fail instead, for testing, set
[`FFMPEG_FALLBACK_TO_PLEX=off`](#ffmpeg_fallback_to_plex).

## Subtitles

- **Text subtitles inside a film** (SRT, ASS, WebVTT) are read from the file
  on the mount, all of a file's in one pass. Subtitle files beside the film are
  read from the mount when they can be matched (see above). Plex reads anything
  that can't be. `FFMPEG_SUBTITLES=off` leaves all of it to Plex.
- **PGS subtitles** are cut out of the film once, and each player draws them
  over the picture, so the film is copied as if it had none.
  `FFMPEG_PGS_MAX_GB` (2 by default) limits the disk they use.
  `FFMPEG_PGS=off` burns them in instead.
- **Subtitles that must be burned in** (VobSub, DVB, or a text subtitle the
  player can't draw) are drawn by ffmpeg in a re-encode: picture subtitles from
  the film or the file beside it, text subtitles by libass from their text,
  with the fonts the film carries.

## Seek-bar previews

Plex makes preview thumbnails only for libraries with **Generate video preview
thumbnails** on, and only once its scheduled task has reached a file. For a
file without them, the engine makes them the first time someone opens the
title: one 320-pixel frame every 10 seconds, at the lowest CPU priority, one
file at a time. HDR frames are tone-mapped.

Previews are kept in the data folder under `previews`, so each file is done
once. The first viewer of a long film may see them arrive a minute or two in.
`FFMPEG_PREVIEWS=off` turns this off, and `FFMPEG_PREVIEWS_MAX_GB` (20 by
default) limits the folder's size.

## HDR

| Stream | Result |
|---|---|
| A copy, for a screen in HDR | Kept as it is |
| A re-encode for a player that decodes HEVC, on a screen in HDR | Kept as HDR10, in HEVC Main10. `FFMPEG_HDR_REENCODE=tonemap` maps it to SDR instead. |
| HDR10 or Dolby Vision 7 or 8.1 for a player that decodes HEVC, on a screen in SDR | The same stream as for screens in HDR, labelled for the browser to map (see below). With `FFMPEG_HDR_ON_SDR=server`, and always for HLG: mapped to SDR in the container, in HEVC Main10. |
| H.264, for a player that can't decode HEVC | Mapped to SDR |
| A burned-in subtitle | Mapped to SDR, so the subtitle isn't too bright |
| Dolby Vision 5 | Mapped to SDR, with its metadata applied |
| Dolby Vision 8.2 and 10.2 | Played as the SDR picture they carry |

Mapping to SDR uses the curve in `FFMPEG_TONEMAP`, `mobius` by default, which
is the closest match to Plex's own apps. `reinhard` lifts dark areas more and
dims highlights.

With the Plex engine, a player on a screen in SDR receives H.264 mapped to SDR
by Plex, as Plex's own web player does.

### HDR on a screen in SDR

Chrome, and so Discord, maps HDR to an SDR screen itself, using the peak
brightness the stream declares, or 1,000 nits when it declares none. At that
peak most films look too dark.

For a screen in SDR, the engine therefore labels the stream with a lower peak,
`FFMPEG_HDR_ON_SDR_NITS` (200 by default). Only the stream's header differs:
a player on a screen in HDR receives the film's own mastering values, and
both screens share the same segments. At 200 nits, the player shows reference
white as white. Values below 200 look the same as 200; higher values look
darker, and anything brighter than the label shows as white.

`FFMPEG_HDR_ON_SDR=server` maps HDR to SDR in the container instead, from the
film's 10 bits, and gives that viewer a stream of their own.

Each player reports whether its screen shows HDR when it joins. **Stats for
nerds** shows the stream's range on the **Range** row, in amber when HDR
reaches a screen in SDR. When a screen changes mid-film (HDR turned on or off,
or the window moved to another screen), the player fetches the header for its
new screen and continues where it was; if it is the host's player, the room
waits meanwhile. Where the stream can't be relabelled (HLG, or server mode), a
viewer whose screen leaves HDR moves onto a stream of their own made for SDR.

## Smooth playback on every device

Each player counts the frames it drops every two seconds. A player that drops
5% or more in four checks in a row (eight seconds of playback) is moved, on its
own, onto a lighter picture of the same film, one step at a time, until it
plays smoothly:

| Dropping frames on | Moves to |
|---|---|
| AV1 | HEVC |
| HEVC, 10-bit | HEVC, 8-bit, with HDR mapped to SDR |
| HEVC, 8-bit | H.264 |

The device remembers this and starts on the lighter picture next time. An
8-bit film re-encoded to HEVC is made in 8 bits to begin with, and AV1 is sent
only to players that decode it in hardware.

Only frames the decoder couldn't keep up with count. A check is skipped while
the Activity is hidden, resized, entering fullscreen or popping out; while
the film is paused, seeking, changing speed or loading a new stream; and when
the page itself draws fewer frames than the film has, because a busy or
throttled computer drops frames whatever it plays. One smooth check ends the
run, so a single burst of dropped frames never moves anyone.

A decoder can also stop altogether: the video has downloaded, but no picture
comes out of it, or only a frame every few seconds, and none count as dropped.
After 10 seconds of that, with the Activity in view and at least 3 seconds of
video downloaded, the player gives up the picture it is on, AV1 or all of
HEVC, remembers that, and moves to a stream without it. If the picture is
already H.264, or is still stuck after the move, the player tells the viewer
to quit Discord fully and open it again. The decoder belongs to Discord, and
closing the Activity doesn't restart it.

## Plex dashboard, Tautulli and Tracearr

Plex doesn't know about streams it isn't making, so the server reports them to
Plex the way players that play files directly do. The engine's streams appear
in Plex's dashboard, and so in Tautulli and Tracearr:

- They are listed under `PLEX_TOKEN`'s account, and watch progress is saved on
  that account.
- Plex labels them **Direct Play** at the file's own bitrate, because it has no
  way to know about the engine's encode.
- Plex and Tautulli can't stop them. Stop them from the Activity.

`FFMPEG_REPORT_TO_PLEX=0` turns this off.

## Bandwidth and the qBittorrent manager

Each viewer downloads the stream as with the Plex engine. A copy is the file's
own bitrate. A re-encode is made at what the source needs: about the source's
bitrate, more for a codec that needs more bits (HEVC to H.264 doubles it), and
less for a smaller picture. It never exceeds `VIDEO_BITRATE_KBPS` or the
viewer's quality, and never drops below 1.5, 2.5 or 4 Mbps for SD, 720p or
1080p.

Plex lists the engine's streams without a bandwidth, so the server gives the
[qBittorrent manager](qBittorrent-Manager-API) its own figure for each stream:
the file's average for a copy, and the video target plus the audio for a
re-encode.

## Settings

All are optional except `PLAYBACK_ENGINE`. An empty value means the default.
The switches turn off with `off` or `0`.

### `PLAYBACK_ENGINE`

`ffmpeg` has this container make the streams. Any other value, or none, means
Plex makes them.

### `MEDIA_PATH_MAP`

`Plex's path=>path in this container`, separated by commas, for a library
mounted at other paths than Plex's. See
[Map the library paths](#2-map-the-library-paths).

### `FFMPEG_HWACCEL` and `FFMPEG_HWACCEL_DEVICE`

What re-encodes run on. Each option is tested with a short encode at startup.

| Value | Uses |
|---|---|
| `auto` (default) | Intel Quick Sync; otherwise VAAPI on the same render node; otherwise the CPU |
| `qsv` | Intel Quick Sync; otherwise the CPU |
| `vaapi` | VAAPI, for AMD, or Intel without Quick Sync's runtime |
| `nvenc` | NVIDIA NVENC, scaling on CUDA |
| `none` | The CPU (x264) |

`FFMPEG_HWACCEL_DEVICE` is the render node for `qsv` and `vaapi`
(`/dev/dri/renderD128` by default), or the GPU's number for `nvenc`.

### `FFMPEG_HW_DECODE`

On by default. `off` keeps encoding on the GPU but decodes on the CPU, for a
GPU whose decoder fails on some files.

### `FFMPEG_MAX_ENCODES`

How many re-encodes run at once. Beyond it, Plex makes the stream. The default
is 6 on a GPU and 2 on the CPU. Copies don't count.

### `FFMPEG_PRESET`

The encoder's balance of speed and quality: `ultrafast`, `superfast`,
`veryfast`, `faster`, `fast`, `medium`, `slow`, `slower` or `veryslow`. By
default each encoder uses its own: `faster` on the CPU, `medium` on Quick Sync,
`p4` on NVENC. NVENC takes the names as `p1` to `p7`. VAAPI has no presets.

### `FFMPEG_LOOKAHEAD`

By default, each stream's whole film is made ahead, then the part before where
it started, so every seek lands in video that is already made. A number of
seconds instead keeps each stream only that far ahead of the room, continuing
as the room approaches. This uses less disk and GPU time, but seeks beyond
what is made take longer.

### `FFMPEG_AUDIO_CHANNELS`

By default (`6`), surround sound the player can't play (DTS, TrueHD, or AC3 in
a browser without it) becomes 5.1 AAC. `2` makes it stereo instead, as Plex
does. Stereo stays stereo, and sound the player can play is copied, either way.

### `FFMPEG_SUBTITLES`, `FFMPEG_PGS` and `FFMPEG_PGS_MAX_GB`

See [Subtitles](#subtitles).

### `FFMPEG_PREVIEWS` and `FFMPEG_PREVIEWS_MAX_GB`

See [Seek-bar previews](#seek-bar-previews). Beyond `FFMPEG_PREVIEWS_MAX_GB`,
the least recently used previews are removed.

### `FFMPEG_SEGMENT_MEMORY_MB`

Memory for the segments rooms are fetching now, so viewers who ask for the
same segment within seconds of each other are served without reading the
disk. 512 by default; `0` reads every segment from disk.

### `FFMPEG_FALLBACK_TO_PLEX`

On by default. `off` makes a stream the engine can't make fail to start,
with the reason, instead of going to Plex. For testing.

### `FFMPEG_HDR_REENCODE` and `FFMPEG_TONEMAP`

`keep` (default) or `tonemap`; see [HDR](#hdr). `FFMPEG_TONEMAP` is the curve:
`mobius` (default), `reinhard`, `hable`, `bt2390`, `linear`, `gamma` or `clip`.

### `FFMPEG_HDR_ON_SDR` and `FFMPEG_HDR_ON_SDR_NITS`

`browser` (default) or `server`; see
[HDR on a screen in SDR](#hdr-on-a-screen-in-sdr). `FFMPEG_HDR_ON_SDR_NITS` is
the peak the stream is labelled with, from 100 to 1000, 200 by default.

### `FFMPEG_REPORT_TO_PLEX`

On by default. `0` stops reporting the engine's streams to Plex; see
[Plex dashboard, Tautulli and Tracearr](#plex-dashboard-tautulli-and-tracearr).

### `FFMPEG_PATH` and `FFPROBE_PATH`

Another ffmpeg than the image's own (Jellyfin's build, at
`/usr/lib/jellyfin-ffmpeg/ffmpeg`), for running from source. `FFPROBE_PATH`
defaults to the ffprobe beside `FFMPEG_PATH`. Use Jellyfin's build there too:
other builds number segment boundaries differently after a seek, which can
produce very short or very long segments.

### Settings shared with the Plex engine

`DIRECT_STREAM`, `DIRECT_STREAM_MAX_KBPS`, `VIDEO_BITRATE_KBPS`, `AV1_TRANSCODE`
and the stream caches (`DIRECT_STREAM_MEMORY_MB`, `STREAM_CACHE_DIR`,
`TRANSCODE_CACHE_MB`) apply to the engine's streams as well. See the
[Configuration Reference](Configuration-Reference).

## Switching back to Plex

Remove `PLAYBACK_ENGINE` (or set it to `plex`) and recreate the container.

## Next

→ [Optional Integrations](Optional-Integrations) ·
[Troubleshooting](Troubleshooting#ffmpeg-engine)
