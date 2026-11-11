# Requirements

Check these before you start. Each row links to the page where you set it up.

## Checklist

| You need | Details | Set up in |
|---|---|---|
| A Plex Media Server | With its transcoder working | [Plex Setup](Plex-Setup) |
| The Plex owner's token | The server owner's `X-Plex-Token` | [Plex Setup](Plex-Setup) |
| Docker with Compose v2 | `docker compose`, or a stack manager such as Portainer, Dockge or Dockhand. The published image is built for x86-64 (`linux/amd64`). | [Installation](Installation) |
| A Discord application | Free, created in the Discord Developer Portal | [Discord Application Setup](Discord-Application-Setup) |
| A public HTTPS address | Discord only loads Activities over HTTPS | [HTTPS and Reverse Proxy](HTTPS-and-Reverse-Proxy) |
| Enough upload speed | About 20 to 25 Mbps for a room at the default quality. See [Upload speed](#upload-speed). | This page |

Running from source also needs Node.js 24 or later. See
[Local Development](Local-Development).

## Server hardware

The server itself is light. The work is in making the video streams, and most
of the time there is very little of it.

- **Direct play is cheap.** When a viewer's device can play a file's video, the
  video is sent unchanged and only the audio is converted if needed. Most
  H.264 and HEVC files play this way, 4K included.
- **Transcoding needs a GPU.** A file above your bitrate limit, or a viewer
  whose device can't play the file, needs a transcode. With hardware encoding,
  a 1080p transcode runs comfortably on modest hardware. On the CPU alone, one
  transcode can occupy several cores, and a 4K source may not keep up. A
  transcode keeps the file's own size, so a 4K transcode is about four times
  the work of a 1080p one.

Where transcodes run depends on the playback engine you choose:

| Engine | Transcodes run in | What it needs |
|---|---|---|
| Plex (the default) | Plex's transcoder | Hardware acceleration turned on in Plex, which needs Plex Pass and a supported GPU |
| [FFmpeg engine](FFmpeg-Engine) | This container | Your library mounted into the container, and a GPU: Intel Quick Sync or VAAPI through `/dev/dri`, or NVIDIA NVENC. Without a GPU, transcodes are H.264 on the CPU, two at a time. |

Viewers with the same audio track and quality share one stream, so a room of
four on the same settings costs one stream, not four. See
[Streaming and Quality](Streaming-and-Quality#shared-and-personal-streams).

### Memory and disk

The server keeps the films being played, so seeking backwards is instant.

| What is kept | Default | Setting |
|---|---|---|
| Direct-play video in memory, all streams together | 6 GB | `DIRECT_STREAM_MEMORY_MB` |
| Direct-play video beyond that, on disk until its stream ends | About 11 GB per hour of film at the 25 Mbps limit | `STREAM_CACHE_DIR` |
| Transcoded video in memory, all streams together | 2 GB | `TRANSCODE_CACHE_MB` |

With the FFmpeg engine, each stream's film is also written to
`STREAM_CACHE_DIR` as it is made. On a server with less memory, lower both
memory settings. See
[Configuration Reference](Configuration-Reference#stream-caches).

## Upload speed

Your upload speed is usually the limit. At the default settings, one stream
needs:

| Stream | Bitrate |
|---|---|
| Direct play | The file's own bitrate, up to 25 Mbps on average |
| Transcode | Up to 20 Mbps on average, with peaks up to 33 Mbps |

A full room does not cost that much per viewer. Video reaches viewers through
Discord's proxy, which caches it, and viewers on the same stream pass pieces to
each other. The second and later viewers of a stream get most of their video
that way, not from your server. How much depends on where your viewers are, so
plan like this:

| Situation | Plan for |
|---|---|
| Everyone on the same stream | One stream's bitrate, plus a margin |
| Viewers on streams of their own (another audio track, a lower quality, a device that needs a transcode) | One stream's bitrate for each of those streams |

The [Dashboard](Dashboard) shows, live and for every past session, how much of
the data came from your server, from Discord's cache and from other viewers.

If your upload is limited:

1. **Lower the defaults.** For example, `VIDEO_BITRATE_KBPS=8000`,
   `VIDEO_PEAK_BITRATE_KBPS=12000` and `DIRECT_STREAM_MAX_KBPS=10000` keep each
   stream near 10 Mbps. Files above the direct-play limit are then transcoded.
   See [Streaming and Quality](Streaming-and-Quality#choosing-your-bitrate-limits).
2. **Let viewers choose a lower quality.** Each viewer can pick 20, 12, 10, 8
   or 4 Mbps for themselves in the player.

## HTTPS

Discord refuses to load an Activity from an insecure address. You need a
public HTTPS address that forwards to the container's port 3000. It must stay
the same, because you enter it both in the Discord Developer Portal and in the
server's settings. A Cloudflare Tunnel or your existing reverse proxy both
work. See [HTTPS and Reverse Proxy](HTTPS-and-Reverse-Proxy).

## Discord clients

| Client | Support |
|---|---|
| Discord desktop app (Windows, macOS, Linux) | Full |
| Discord in Chrome, Edge or another Chromium browser | Full |
| Discord in Firefox | Full. Firefox can't play HEVC, so it receives H.264. |
| Discord on iOS and Android | Full, with a layout made for phones |

Each player tells the server what it can play, and the server sends it a
stream that suits it. See
[Streaming and Quality](Streaming-and-Quality#what-each-viewer-receives).

## Next

→ [Discord Application Setup](Discord-Application-Setup)
