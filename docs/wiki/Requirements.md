# Requirements

Check these before you start. Each item links to the page where you set it up.

## Checklist

| Requirement | Details | Set up in |
|---|---|---|
| Plex Media Server | With its transcoder working | [Plex Setup](Plex-Setup) |
| The Plex owner's token | The server owner's `X-Plex-Token` | [Plex Setup](Plex-Setup#get-plex_token) |
| Docker with Compose v2 | `docker compose`, or a stack manager such as Portainer or Dockge. The published image is built for x86-64 (`linux/amd64`). | [Installation](Installation) |
| A Discord application | Free, created in the Discord Developer Portal | [Discord Application Setup](Discord-Application-Setup) |
| A public HTTPS address | Discord loads Activities only over HTTPS | [HTTPS and Reverse Proxy](HTTPS-and-Reverse-Proxy) |
| Upload bandwidth | About 20–25 Mbps per viewer at the default quality | [Bandwidth](#bandwidth) |

Running from source also needs Node.js 24 or later. See
[Local Development](Local-Development).

## Server hardware

The server itself is light. The work is in making the video streams:

- **Copying is cheap.** When a viewer's player can decode a file's video, the
  video is copied as it is (Direct Stream) and only the audio is converted if
  needed. Most H.264 and HEVC files up to 1080p are copied.
- **Re-encoding needs a GPU.** Files above 1080p, files above the copy bitrate
  limit, and streams for players that can't decode the file are re-encoded.
  With hardware encoding, a 1080p re-encode runs comfortably on modest
  hardware. On the CPU alone, one re-encode can occupy several cores, and a 4K
  source may not keep up.

Where re-encodes run depends on the playback engine:

| Engine | Re-encodes run in | Hardware |
|---|---|---|
| Plex (default) | Plex's transcoder | Hardware acceleration in Plex, which needs Plex Pass and a supported GPU |
| [FFmpeg engine](FFmpeg-Engine) | This container | A GPU mapped into the container: Intel Quick Sync or VAAPI through `/dev/dri`, or NVIDIA NVENC. Without one, re-encodes are H.264 on the CPU, two at a time. |

Viewers with the same audio track, burned-in subtitles and quality share one
stream, so a room of four on the same settings costs one stream, not four. See
[Streaming and Quality](Streaming-and-Quality#shared-and-personal-streams).

### Memory and disk

The server keeps the films being played, so seeking back plays at once:

| What | Default | Setting |
|---|---|---|
| Copied video in memory, all streams together | 6 GB | `DIRECT_STREAM_MEMORY_MB` |
| Copied video beyond that, on disk until its stream ends | Up to about 11 GB per hour of film at the 25 Mbps copy limit | `STREAM_CACHE_DIR` |
| Re-encoded video in memory, all streams together | 2 GB | `TRANSCODE_CACHE_MB` |

With the FFmpeg engine, each stream's film is also written to
`STREAM_CACHE_DIR` as it is made. On a server with less memory, lower both
memory settings. See
[Configuration Reference](Configuration-Reference#stream-caches).

## Bandwidth

Each viewer downloads the stream from your server, so your upload speed is
usually the limit. At the default settings, a viewer downloads:

| Stream | Per viewer |
|---|---|
| Copied file (Direct Stream) | The file's own bitrate, up to 25 Mbps on average |
| Re-encoded | Up to 20 Mbps on average, with peaks up to 33 Mbps |

Plan for this much upload:

| Viewers | Upload at the defaults |
|---|---|
| 1 | 20–25 Mbps |
| 2 | 40–50 Mbps |
| 4 | 80–100 Mbps |
| 8 | 160–200 Mbps |

Viewers on the same stream also pass segments to each other, peer to peer,
once their buffers are full. This can reduce your upload considerably, but it
depends on each viewer's connection, so plan without it.

If your upload is lower:

1. **Lower the defaults.** For example, `VIDEO_BITRATE_KBPS=8000`,
   `VIDEO_PEAK_BITRATE_KBPS=12000` and `DIRECT_STREAM_MAX_KBPS=10000` keep each
   viewer near 10 Mbps. Files above the copy limit are then re-encoded. See
   [Streaming and Quality](Streaming-and-Quality#choosing-the-bitrate-limits).
2. **Let viewers choose a lower quality.** Each viewer can choose 20, 12, 10, 8
   or 4 Mbps for themselves in the player.
3. **Use the [VPS Relay](VPS-Relay).** Your server uploads each stream once to a
   VPS, and the VPS serves the room.

## HTTPS

Discord refuses to load an Activity from an insecure address. You need a
public HTTPS address that forwards to the container's port 3000. It must stay
the same, because it is entered both in the Discord Developer Portal and in the
server's settings. A Cloudflare Tunnel or an existing reverse proxy both work.
See [HTTPS and Reverse Proxy](HTTPS-and-Reverse-Proxy).

## Discord clients

| Client | Support |
|---|---|
| Discord desktop app (Windows, macOS, Linux) | Full |
| Discord in Chrome, Edge or another Chromium browser | Full |
| Discord in Firefox | Full. Firefox can't decode HEVC, so it receives H.264. |
| Discord on iOS and Android | Full, with a layout for phones |

Each player reports what it can decode, and the server sends it a stream it
can play. See
[Streaming and Quality](Streaming-and-Quality#what-each-player-receives).

## Next

→ [Discord Application Setup](Discord-Application-Setup)
