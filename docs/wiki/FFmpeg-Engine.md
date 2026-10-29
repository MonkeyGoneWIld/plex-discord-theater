# FFmpeg Engine

By default Plex makes the streams the Activity plays. With
`PLAYBACK_ENGINE=ffmpeg`, the container makes them itself, with its own ffmpeg,
from the files on disk. Plex still provides the library, the metadata and the
watch history, and it still makes any stream ffmpeg can't.

It is optional. Leave `PLAYBACK_ENGINE` unset and Plex makes every other
stream, as before. The image is the same either way, so switching is a setting
and a restart.

---

## Why use it

- **The original picture whenever the player can decode it.** H.264 and HEVC
  files are copied, HDR10, HLG and Dolby Vision 7 and 8 included, under the
  same rules as [Direct Stream](Configuration-Reference#direct_stream).
- **Re-encodes keep HDR.** A stream re-encoded for bitrate or quality, for a
  player that decodes HEVC, comes out as HDR10 HEVC Main10, so it looks like
  the copy, only softer. Plex maps every re-encode to SDR.
- **Dolby Vision 5 in the right colours.** Plex copies it, and browsers show it
  purple and green. ffmpeg re-encodes it with its Dolby Vision metadata applied
  (on the GPU, where OpenCL works).
- **Seeks land at once.** Each stream's whole film is made ahead, flat out —
  a copy in a minute or two, a re-encode in ten to thirty — and kept until the
  stream ends, so a seek anywhere in it plays from here without a restart.
  A stream started partway in, from a resume or a seek, then makes the part
  before where it started too, so a seek back is served from what is made.
- **Re-encodes at the source's own bitrate.** A 3 Mbps HEVC film re-encoded to
  H.264 is made at about 6 Mbps, not at the quality level's 12, so viewers
  download only what the picture needs.
- **Every subtitle burned in.** Text subtitles (SRT, ASS with its own fonts)
  and picture ones beside the film (`.sup`, VobSub) are drawn by ffmpeg too.
- **Seek-bar previews for every file.** Where Plex never made preview
  thumbnails, ffmpeg makes them, once per file.
- **Plex's transcoder does nothing.** The work runs in this container, on the
  GPU when one is mapped in: Intel Quick Sync, VAAPI (AMD, or Intel), or NVIDIA
  NVENC.

## What it needs

| | |
|---|---|
| **The library, mounted read-only** | At the path Plex has it, or mapped with [`MEDIA_PATH_MAP`](#media_path_map). Without it ffmpeg reads each file from Plex over the network. That works, but seeks are slower. |
| **A GPU, for re-encodes** | `/dev/dri` for Intel Quick Sync or VAAPI, or NVIDIA's container runtime for NVENC (see [`FFMPEG_HWACCEL`](#ffmpeg_hwaccel--ffmpeg_hwaccel_device)). Without one, re-encodes are H.264 on the CPU, and copies are unaffected. |
| **Disk for the streams** | Each stream's film is written to `STREAM_CACHE_DIR` as it is made, and kept until the stream ends: a copy takes the file's own size (a 4K remux, 50 to 80 GB), a re-encode its bitrate times its length (a 1080p film, about 4 to 8 GB). [`FFMPEG_LOOKAHEAD`](#ffmpeg_lookahead) holds each run that far ahead of the room instead. |
| **Plex, as before** | For the library, and for the streams ffmpeg leaves to it. Keep [transcoding working](Plex-Setup#transcoding-must-work). |

The image ships Jellyfin's ffmpeg with Intel's media and OpenCL drivers, and
fonts for subtitles, so nothing needs installing in the container. It was
tested on a Core Ultra 7 265K. VAAPI on AMD and NVENC are built in but haven't
been tried on real hardware yet.

### Compose

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
      # Plex has the library at /data/media too, so no MEDIA_PATH_MAP.
      # ...the rest as in the Installation page
```

The container's user is added to `/dev/dri`'s groups at startup, so no
`group_add` is needed.

When Docker runs inside a Proxmox LXC or a VM, the GPU has to be passed through
to that first, and then mapped into the container as above.

For NVIDIA, install the NVIDIA Container Toolkit on the host, and instead of
`/dev/dri`:

```yaml
    runtime: nvidia
    environment:
      NVIDIA_VISIBLE_DEVICES: "all"
      NVIDIA_DRIVER_CAPABILITIES: "compute,video,utility"
      FFMPEG_HWACCEL: "nvenc"
```

### Library paths

ffmpeg opens the file at the path Plex reports for it, which is the folder you
added under **Settings → Libraries**. If Plex runs in another container, it
probably sees the library under another path than this one does. Map one onto
the other:

```env
MEDIA_PATH_MAP=/media/movies=>/data/media/movies,/media/tv=>/data/media/tv
```

Each pair is `Plex's path=>the path here`, and the first one that matches is
used.

To check every library at once:

```bash
docker exec -it plex-discord-theater node scripts/diagnose-ffmpeg.mjs paths
```

This command samples titles from each library, says which it can read, and
suggests a map for any it can't. The server does a quicker version of it at
every start:

```text
[Config] library on the mount: Movies 10/10 readable, TV Shows 10/10 readable
```

A library that isn't fully readable is a warning, with the paths it couldn't
find. What isn't readable is read through Plex.

---

## Checking it works

### The startup line

```bash
docker compose logs | grep 'playback engine'
```

```text
[Config] playback engine: ffmpeg — ffmpeg version 8.1.3-Jellyfin …; copies H.264 and HEVC files itself, HDR included; re-encodes on Intel QSV (HEVC Main10 and H.264), tone mapping mobius on OpenCL, subtitles burned in (text ones from their text, with their fonts); 512 MB of segments kept in memory; previews made for files Plex has none for; library at Plex's own paths
```

At startup it tries a short HEVC Main10 encode and a short H.264 encode on the
GPU, and a short OpenCL tone map. If anything didn't work, the line says what
happened instead:

| The line says | Meaning |
|---|---|
| `re-encodes on Intel QSV …, tone mapping … on OpenCL` | Everything works |
| `re-encodes on VAAPI …` or `NVIDIA NVENC …` | The GPU named, or the one `auto` found when QSV didn't work |
| `… on QSV's video engine (OpenCL didn't: …; Dolby Vision 5 goes to Plex)` | Re-encodes are on the GPU, but Dolby Vision 5 is left to Plex |
| `CPU (no /dev/dri/renderD128; /dev/dri has: …)` | The GPU isn't mapped in. It is looked for again before each re-encode, so mapping it in later works without a restart. |
| `CPU (Intel QSV didn't encode: …)` | The GPU is there, but the encode test failed. See [Troubleshooting](Troubleshooting#re-encodes-run-on-the-cpu). |
| `ffmpeg wanted … but not found` | Every stream goes to Plex. Check `FFMPEG_PATH`, or that the image is a current one. |

### Per stream

**Stats for nerds** (`I`) has an **Engine** row: `ffmpeg` with what encodes
and decodes it (`ffmpeg · Intel QSV, GPU decode`), or `Plex`. A stream ffmpeg
left to Plex says why, in amber: `Plex (ffmpeg: encode slots full (6/6))`. Its
**Playback** row says whether the stream is a copy or a re-encode, and why.

The server log has one line per stream:

```text
[FFmpeg] copying session=… ratingKey=… source=mount …
[FFmpeg] re-encoding session=… ratingKey=… source=mount …
```

`source=plex` instead of `source=mount` means the file wasn't readable at its
mapped path, and ffmpeg read it from Plex over the network.

### Is the GPU doing the work?

Each re-encode logs how much of the GPU and the CPU its ffmpeg used, from the
kernel's own count for that process. The figures appear when it pauses far
enough ahead of the room, and again when it stops:

```text
[FFmpeg] run stopped session=… gpu=video 34%, render 12%, video-enhance 0%, copy 0% over 61.2 s (i915, /dev/dri/renderD128) cpu=0.4 cores read=9 Mbps
```

`gpu=none: ffmpeg had no GPU open, so the CPU did the work` means just that.

> [!NOTE]
> Use this rather than `intel_gpu_top` on the host. On the test server,
> `intel_gpu_top` showed every engine idle, with only `IRQ/s` moving, through
> re-encodes that the kernel's count, above, had on the GPU.

For a full check of the GPU (the ffmpeg build, `/dev/dri` and its permissions,
`vainfo`, OpenCL and test encodes):

```bash
docker exec -it plex-discord-theater node scripts/diagnose-ffmpeg.mjs gpu
```

---

## When a stream goes to Plex

ffmpeg makes what it can, and leaves the rest to Plex stream by stream. Other
viewers in the room stay on ffmpeg. The log says why, on a `[FFmpeg] … left to
Plex` line.

| Left to Plex when | Why |
|---|---|
| A text subtitle inside the film is burned in, and its text hasn't been read out yet | ffmpeg needs the whole text to draw it. It is read out meanwhile, so the next start, a seek included, is ffmpeg's. An `.mkv`'s text is usually read straight away. |
| A picture subtitle beside the film (`.sup`, `.idx`) isn't found on the mount | ffmpeg needs the file. It is found when exactly one file in the film's folder is named after the film and says the subtitle's language and flags (`Film (2001).en.forced.sup`). |
| Dolby Vision 5 without OpenCL | Only OpenCL applies its metadata. Without it the colours would be wrong. |
| Every re-encode slot is taken | [`FFMPEG_MAX_ENCODES`](#ffmpeg_max_encodes). Copies don't take one. |
| The file on disk isn't the size Plex has for it | It was replaced since Plex last looked. Plex is asked again once, then the stream is Plex's until it rescans. |
| The file's tracks aren't the ones Plex lists | Read by `ffprobe` before the first start of each file, so an audio or subtitle choice can't pick the wrong track. |
| Neither the mount nor Plex's file link gives ffmpeg the file | Plex can still read it |
| ffmpeg failed on the title twice in 15 minutes | It goes to Plex until 15 minutes after the last failure |

[`FFMPEG_FALLBACK_TO_PLEX=off`](#ffmpeg_fallback_to_plex) makes these fail to
start instead, to find out what they are.

## Subtitles

Text subtitles inside a film (SRT, ASS, WebVTT) are read out of the file on the
mount by ffmpeg rather than by Plex, all of one file's in one pass, and
subtitles beside the film are read off the mount when they can be told apart
(see above). Plex reads whatever can't be. `FFMPEG_SUBTITLES=off` leaves all of
it to Plex, as without the engine.

A subtitle burned into the picture — a picture subtitle, or a text one the
player can't draw — is drawn by ffmpeg in a re-encode: a picture one from the
film or from its file beside it, a text one by libass from its text, an ASS
track with the fonts the film carries for it.

## Seek-bar previews

Plex makes preview thumbnails only for libraries with **Generate video preview
thumbnails** on, and only once its scheduled task has reached a file. For any
file it has none for, ffmpeg makes them the first time someone opens the title:
a 320-pixel frame every 10 seconds, one seek per frame rather than the whole
file read through, at the lowest CPU priority, one file at a time. HDR films'
frames are tone-mapped.

They are kept in the data folder, under `previews`, so each file is done once.
The first viewer of a long film may see them arrive a minute or two into it.
[`FFMPEG_PREVIEWS`](#ffmpeg_previews--ffmpeg_previews_max_gb) turns this off,
and `FFMPEG_PREVIEWS_MAX_GB` (20 by default) bounds the folder.

## HDR

| Stream | HDR |
|---|---|
| Copy, for a screen that shows HDR | Kept, untouched, as in Plex mode |
| Re-encode for a player that decodes HEVC, on a screen that shows HDR | Kept: HDR10, in HEVC Main10, never AV1. `FFMPEG_HDR_REENCODE=tonemap` maps it to SDR instead, as Plex does. |
| A player that decodes HEVC, on a screen in SDR | HDR10 and Dolby Vision 7 and 8.1: sent as HDR (copied, or kept in HEVC Main10), labelled 200 nits for the browser to map. With `FFMPEG_HDR_ON_SDR=server`, and for HLG: mapped to SDR here from the film's 10 bits, into HEVC Main10 |
| H.264 (a player that can't decode HEVC, such as Discord in Firefox) | Mapped to SDR |
| A subtitle burned in | Mapped to SDR, so the subtitle isn't blinding |
| Dolby Vision 5 | Mapped to SDR, with its metadata applied |
| Dolby Vision 8.2 and 10.2 | SDR underneath, played as SDR |

The curve used for SDR is `FFMPEG_TONEMAP`, `mobius` by default (at 0.5).
Measured on the same frames against Plex's app for Windows, it is the closest;
`reinhard` lifts the darks more and dims the whites.

### HDR on a screen in SDR

Chrome, and so Discord, maps HDR to an SDR screen itself, from the picture's
10 bits, by a curve set by the brightest the stream says it gets: its
mastering display's peak or its MaxCLL, 1,000 nits when it says nothing. At
1,000 nits a face lit at 100 nits shows at grey 136 of 255, darker than Plex's
app for Windows shows it. A page can't do better itself: what it can read of
the picture is 8 bits, and lifting that bands dark scenes.

So for a screen in SDR the stream is labelled a lower peak,
`FFMPEG_HDR_ON_SDR_NITS` (200 by default): the HEVC's HDR SEI is left out of
its frames and its init segment, and the init says 200 nits in `mdcv` and
`clli` instead. Chrome then shows that face at grey 186, and reference white
(203 nits) as white, as does anything brighter. A lower label is no brighter:
Chrome maps to nothing under its own SDR white. At 300 the face is 174 and
reference white 240, with white from 300 nits up. The stream is in
fragmented MP4, where those boxes go. Closed captions are read from the file,
so leaving the SEI out doesn't lose them.

Plex's app for Windows also adapts to each scene, and lifts dark scenes a
little more than this does. `FFMPEG_HDR_ON_SDR=server` maps HDR to SDR on the
server instead.

On a screen in SDR (Windows runs an HDR monitor in SDR unless HDR is switched
on), Chrome shows HDR with its reference white at half the screen's light,
about a stop darker than the film's SDR grade. Brightening that 8-bit picture
in the player broke dark scenes into blocks and bands (Endgame at 32:00), so
the server maps HDR to SDR instead, from the film's 10 bits, as Plex does. Each
player says on joining whether its screen shows HDR. A viewer whose screen
doesn't gets a stream of their own, mapped, and nobody else's stream changes.
In Plex mode Plex is asked for H.264 mapped to SDR, as Plex's own web player
does on a screen in SDR. Stats for nerds shows the stream's range on the Range
line, in amber when HDR reaches a screen in SDR.

A screen that leaves HDR mid-film moves its viewer onto a stream of their own
made for a screen in SDR, the one they would have had starting on it: the
labelled HEVC when their player decodes HEVC, not H.264. One that comes back
to HDR is sent HDR again after rejoining. A viewer whose screen
shows HDR, in a room whose host's doesn't, shares the host's mapped stream when
both decode HEVC.

## Plex's dashboard, Tautulli and Tracearr

Plex doesn't know about a stream it isn't making, so the server tells it, the
way players that play files directly do. ffmpeg's streams show in Plex's
dashboard, and so in Tautulli and Tracearr:

- the player is **Plex Discord Theater**, under `PLEX_TOKEN`'s account, as in
  Plex mode, and watch progress is kept on that account;
- Plex labels it **Direct Play** at the file's own bitrate. Plex has no way to
  know about ffmpeg's encode;
- Plex and Tautulli can't stop it. Stop it from the Activity.

`FFMPEG_REPORT_TO_PLEX=0` turns this off.

## Bandwidth and the qBittorrent manager

Each viewer downloads the stream as in Plex mode: a copy at the file's own
bitrate, a re-encode at what the source needs — about the source's bitrate,
more for a codec that needs more bits than the source's (HEVC to H.264 is
double), less for a smaller picture — never above `VIDEO_BITRATE_KBPS` or the
quality level, and never below 1.5, 2.5 or 4 Mbps for SD, 720p or 1080p and up.
See [Requirements](Requirements#bandwidth).

Plex lists ffmpeg's streams with no bandwidth, so the server gives the
[qBittorrent manager](qBittorrent-Manager-API) its own figure for each stream.
For a copy it is the file's average, and for a re-encode it is the video target
plus the audio. The figure stays the same for the whole stream.

---

## Settings

All optional except `PLAYBACK_ENGINE` itself. Empty means the default.

### `PLAYBACK_ENGINE`

`ffmpeg` to have this container make the streams. Anything else, or unset,
means Plex makes them.

### `MEDIA_PATH_MAP`

`Plex's path=>the path here`, comma-separated, for a library mounted at other
paths than Plex's own. Unset, files are opened at Plex's paths. See
[Library paths](#library-paths).

### `FFMPEG_HWACCEL` · `FFMPEG_HWACCEL_DEVICE`

What re-encodes run on, each tried with a short encode at startup:

| Value | |
|---|---|
| `auto` (default) | Intel Quick Sync, else VAAPI on the same render node, else the CPU |
| `qsv` | Intel Quick Sync, else the CPU |
| `vaapi` | VAAPI: AMD, or Intel without Quick Sync's runtime. Its low-power encoder when that is all it has |
| `nvenc` | NVIDIA NVENC, scaling on CUDA |
| `none` | The CPU (x264) |

`FFMPEG_HWACCEL_DEVICE` is the render node for `qsv` and `vaapi`,
`/dev/dri/renderD128` by default, or the GPU's number for `nvenc`.

### `FFMPEG_HW_DECODE`

On unless `off`. Off, the GPU still encodes but the CPU decodes everything:
for a GPU whose decoder fails on some files.

### `FFMPEG_MAX_ENCODES`

How many re-encodes run at once. Past it, Plex makes the stream. The default
is 6 on the GPU and 2 on the CPU. Copies don't count.

### `FFMPEG_PRESET`

The encoder's speed against its quality: `ultrafast`, `superfast`, `veryfast`,
`faster`, `fast`, `medium`, `slow`, `slower` or `veryslow`. Unset, each encoder
has its own: `faster` on the CPU, `medium` on Quick Sync, `p4` on NVENC.
NVENC takes the names as `p1` to `p7`. VAAPI has no presets.

### `FFMPEG_LOOKAHEAD`

Unset, each stream's whole film is made ahead, flat out, then whatever came
before where it started, so every seek lands in what is made already. A number
of seconds holds each run that far ahead of the room instead, carrying on as
the room nears it: less disk and less GPU, slower seeks past it, and the part
before a resume made only once the room nears the end.

### `FFMPEG_AUDIO_CHANNELS`

Unset or `6`: a surround track the player can't play (DTS, TrueHD, AC-3 in
browsers that lack it) becomes 5.1 AAC. `2`: it becomes stereo, as Plex does.
Stereo stays stereo, and tracks the player can play are copied, either way.

### `FFMPEG_SUBTITLES`

On unless `off`. See [Subtitles](#subtitles).

### `FFMPEG_PREVIEWS` · `FFMPEG_PREVIEWS_MAX_GB`

On unless `off`. See [Seek-bar previews](#seek-bar-previews).
`FFMPEG_PREVIEWS_MAX_GB` is the room they get, 20 by default; past it the
least recently used go.

### `FFMPEG_SEGMENT_MEMORY_MB`

Memory for the segments rooms are fetching now, so a room's viewers, who ask
for the same segment within seconds of each other, are sent it without reading
the disk. 512 by default; `0` reads every one from disk.

### `FFMPEG_FALLBACK_TO_PLEX`

On unless `off`. Off, a stream ffmpeg can't make fails to start instead of
going to Plex, and the error says why. For testing.

### `FFMPEG_HDR_REENCODE` · `FFMPEG_TONEMAP`

`keep` (the default) or `tonemap`. See [HDR](#hdr). `FFMPEG_TONEMAP` is the
curve: `mobius` (default), `reinhard`, `hable`, `bt2390`, `linear`, `gamma` or
`clip`.

### `FFMPEG_HDR_ON_SDR` · `FFMPEG_HDR_ON_SDR_NITS`

`browser` (the default) or `server`. See
[HDR on a screen in SDR](#hdr-on-a-screen-in-sdr). `FFMPEG_HDR_ON_SDR_NITS` is
the peak the stream is labelled, 100 to 1000, 200 by default: lower is
brighter, down to 200, and anything above it is white.

### `FFMPEG_REPORT_TO_PLEX`

On unless `0`. See [Plex's dashboard](#plexs-dashboard-tautulli-and-tracearr).

### `FFMPEG_PATH` · `FFPROBE_PATH`

Another ffmpeg than the image's own, Jellyfin's build at
`/usr/lib/jellyfin-ffmpeg/ffmpeg`. Only for running from source.
`FFPROBE_PATH` is its ffprobe, the one beside `FFMPEG_PATH` unless set.

Use Jellyfin's build there too. Another build (upstream 7.1, say) counts
segment cuts from zero, not from where the stream starts: after a seek it
cuts at every keyframe, and late in a long film one segment can run to the
end.

The stream caches (`DIRECT_STREAM_MEMORY_MB`, `STREAM_CACHE_DIR`,
`TRANSCODE_CACHE_MB`), `DIRECT_STREAM`, `DIRECT_STREAM_MAX_KBPS` and
`VIDEO_BITRATE_KBPS` apply to ffmpeg's streams as they do to Plex's. See the
[Configuration Reference](Configuration-Reference).

## Going back to Plex

Unset `PLAYBACK_ENGINE` and restart the container.

## Next

→ [Troubleshooting](Troubleshooting#ffmpeg-engine)
