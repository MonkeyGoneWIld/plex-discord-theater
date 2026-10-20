# Requirements

Check these before starting. Most failed installs come down to one of the first
three.

## You need

| | Why | Notes |
|---|---|---|
| **A Plex Media Server** | The source of everything | Transcoding must work. Direct-play-only setups will not stream to browsers reliably. |
| **Docker** | How this runs | Docker Compose v2 (`docker compose`, not `docker-compose`). |
| **A public HTTPS endpoint** | Discord requirement | See [below](#the-https-requirement). |
| **A Discord account you can make an app with** | The Activity itself | Free. See [Discord Application Setup](Discord-Application-Setup). |
| **A Plex account token** | Library access | The server owner's token. See [Plex Setup](Plex-Setup). |

Building from source instead of using the container also needs **Node.js 24**.

## Hardware, honestly

The Activity itself is light. **Plex's transcoder is not.**

Every watch party is at minimum one transcode. What that costs depends entirely
on your Plex hardware:

- **With hardware transcoding** (Intel Quick Sync, NVENC, or a Plex Pass on
  supported hardware) a 1080p transcode is comfortable on modest kit.
- **Without it**, a single 1080p transcode can saturate several CPU cores. 4K
  source material will likely not keep up at all.

Check Plex's own dashboard while a stream runs. If it says "Transcode (throttled)"
or your CPU pins at 100%, that is your bottleneck, not this project.

With the [ffmpeg engine](FFmpeg-Engine), the work is done in this container
instead of in Plex, on the same terms: copies cost almost nothing, and
re-encodes want an Intel GPU with Quick Sync mapped in as `/dev/dri`. Without
one they run on the CPU, H.264 only, two at a time by default.

A stream is shared by everyone watching with the same audio track, picture
subtitles and quality, so a room of four on the same tracks is one transcode,
not four. With [Direct Stream](Configuration-Reference#direct_stream) on, most
films aren't re-encoded at all: Plex copies the video and converts only the
audio.

### Memory and disk

The server keeps the films being played so going back plays at once. By default
that is up to **6 GB** of memory for copied films and **2 GB** for re-encoded
ones, every stream together, and a copy past its 6 GB goes to disk until its
stream ends, which is up to 13.5 GB an hour for a 30 Mbps Blu-ray. Both are
adjustable; see [Stream caches](Configuration-Reference#stream-caches).

## Bandwidth

This is the constraint people underestimate.

By default **each viewer downloads the stream from your server**. Players on the
same stream share segments with each other once their buffers are full, which
can save a good part of it, but it depends on their connections, so plan
without it. At the default ~12 Mbps target:

| Viewers | Upload needed |
|---|---|
| 1 | ~12 Mbps |
| 4 | ~48 Mbps |
| 8 | ~96 Mbps |

A copied film (Direct Stream) is the file's own bitrate instead, up to
[`DIRECT_STREAM_MAX_KBPS`](Configuration-Reference#direct_stream_max_kbps): a
30 Mbps remux for four viewers is up to 120 Mbps.

Most home connections do not have that upload headroom. Three options:

1. **Lower the bitrate.** `VIDEO_BITRATE_KBPS=6000` roughly halves it, and a
   lower `DIRECT_STREAM_MAX_KBPS` re-encodes the biggest files instead of
   copying them. See
   [Configuration Reference](Configuration-Reference#video-quality). A viewer on
   a slow connection can also pick a lower quality for themselves.
2. **Use the [VPS Relay](VPS-Relay).** Your server uploads *one* stream to a VPS,
   which fans it out to the room. This is the right answer for rooms above three
   or four people.
3. **Keep the room small.**

## The HTTPS requirement

Discord loads Activities inside an iframe and will not load an insecure origin.
You need a real HTTPS URL pointing at the container.

Any of these work:

- **Cloudflare Tunnel** — easiest, free, no port forwarding, no static IP.
  A [named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
  gives you a stable address.
- **A reverse proxy** you already run — nginx, Caddy, Traefik — with a
  certificate from Let's Encrypt.
- **Any other public HTTPS endpoint** that can reach the container.

Whatever you choose, the address must be stable. If it changes you have to update
the URL mapping in the Discord Developer Portal every time, which gets old fast.

## Next

→ [Installation](Installation)
