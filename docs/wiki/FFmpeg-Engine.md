# FFmpeg Engine

By default Plex makes every stream the Activity plays. With
`PLAYBACK_ENGINE=ffmpeg`, the container makes them itself, with its own ffmpeg,
from the files on disk. Plex still provides the library, the metadata and the
watch history, and it still makes any stream ffmpeg can't.

It is optional. Leave `PLAYBACK_ENGINE` unset and nothing changes. The image is
the same either way, so switching is a setting and a restart.

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
- **Plex's transcoder does nothing.** The work runs in this container, on
  Intel's GPU (Quick Sync) when one is mapped in.

## What it needs

| | |
|---|---|
| **The library, mounted read-only** | At the path Plex has it, or mapped with [`MEDIA_PATH_MAP`](#media_path_map). Without it ffmpeg reads each file from Plex over the network. That works, but seeks are slower. |
| **`/dev/dri`, for Quick Sync** | An Intel GPU whose Quick Sync encodes HEVC Main10 and H.264. Without one, re-encodes are H.264 on the CPU, and copies are unaffected. |
| **Plex, as before** | For the library, and for the streams ffmpeg leaves to it. Keep [transcoding working](Plex-Setup#transcoding-must-work). |

The image ships Jellyfin's ffmpeg with Intel's media and OpenCL drivers, so
nothing needs installing in the container. It was tested on a Core Ultra 7
265K.

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
suggests a map for any it can't.

---

## Checking it works

### The startup line

```bash
docker compose logs | grep 'playback engine'
```

```text
[Config] playback engine: ffmpeg — ffmpeg version 8.1.3-Jellyfin …; copies H.264 and HEVC files itself, HDR included; re-encodes on Intel QSV (HEVC Main10 and H.264), tone mapping reinhard on OpenCL, picture subtitles burned in; a text subtitle burned in still goes to Plex; library at Plex's own paths
```

At startup it tries a short HEVC Main10 encode and a short H.264 encode on the
GPU, and a short OpenCL tone map. If anything didn't work, the line says what
happened instead:

| The line says | Meaning |
|---|---|
| `re-encodes on Intel QSV …, tone mapping … on OpenCL` | Everything works |
| `… on QSV's video engine (OpenCL didn't: …; Dolby Vision 5 goes to Plex)` | Re-encodes are on the GPU, but Dolby Vision 5 is left to Plex |
| `CPU (no /dev/dri/renderD128; /dev/dri has: …)` | The GPU isn't mapped in. It is looked for again before each re-encode, so mapping it in later works without a restart. |
| `CPU (Intel QSV didn't encode: …)` | The GPU is there, but the encode test failed. See [Troubleshooting](Troubleshooting#re-encodes-run-on-the-cpu). |
| `ffmpeg wanted … but not found` | Every stream goes to Plex. Check `FFMPEG_PATH`, or that the image is a current one. |

### Per stream

**Stats for nerds** (`I`) has an **Engine** row: `ffmpeg` or `Plex`. Its
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
| A text subtitle is burned into the picture | Not built yet. Text subtitles a player draws itself are fine. |
| Dolby Vision 5 without OpenCL | Only OpenCL applies its metadata. Without it the colours would be wrong. |
| Every re-encode slot is taken | [`FFMPEG_MAX_ENCODES`](#ffmpeg_max_encodes). Copies don't take one. |
| Neither the mount nor Plex's file link gives ffmpeg the file | Plex can still read it |
| ffmpeg failed on the title twice in 15 minutes | It goes to Plex until 15 minutes after the last failure |

## HDR

| Stream | HDR |
|---|---|
| Copy | Kept, untouched, as in Plex mode |
| Re-encode for a player that decodes HEVC | Kept: HDR10 HEVC Main10. `FFMPEG_HDR_REENCODE=tonemap` maps it to SDR instead, as Plex does. |
| H.264 (a player that can't decode HEVC, such as Discord in Firefox) | Mapped to SDR |
| A picture subtitle burned in | Mapped to SDR, so the subtitle isn't blinding |
| Dolby Vision 5 | Mapped to SDR, with its metadata applied |

The curve used for SDR is `FFMPEG_TONEMAP`, `reinhard` by default, the closest
to Plex's.

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
bitrate, a re-encode at about `VIDEO_BITRATE_KBPS`. See
[Requirements](Requirements#bandwidth).

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

`auto` (the default) uses Intel Quick Sync when the startup test encodes on it,
and the CPU when it doesn't; `qsv` is the same. `none` always uses the CPU.
VAAPI and NVIDIA aren't supported yet.

`FFMPEG_HWACCEL_DEVICE` is the render node, `/dev/dri/renderD128` by default.

### `FFMPEG_MAX_ENCODES`

How many re-encodes run at once. Past it, Plex makes the stream. The default
is 4 on the GPU and 2 on the CPU. Copies don't count.

### `FFMPEG_HDR_REENCODE` · `FFMPEG_TONEMAP`

`keep` (the default) or `tonemap`. See [HDR](#hdr). `FFMPEG_TONEMAP` is the
curve: `reinhard` (default), `mobius`, `hable`, `bt2390`, `linear`, `gamma` or
`clip`.

### `FFMPEG_REPORT_TO_PLEX`

On unless `0`. See [Plex's dashboard](#plexs-dashboard-tautulli-and-tracearr).

### `FFMPEG_PATH`

Another ffmpeg than the image's own, Jellyfin's build at
`/usr/lib/jellyfin-ffmpeg/ffmpeg`. Only for running from source.

The stream caches (`DIRECT_STREAM_MEMORY_MB`, `STREAM_CACHE_DIR`,
`TRANSCODE_CACHE_MB`), `DIRECT_STREAM`, `DIRECT_STREAM_MAX_KBPS` and
`VIDEO_BITRATE_KBPS` apply to ffmpeg's streams as they do to Plex's. See the
[Configuration Reference](Configuration-Reference).

## Going back to Plex

Unset `PLAYBACK_ENGINE` and restart the container.

## Next

→ [Troubleshooting](Troubleshooting#ffmpeg-engine)
