# Streaming and Quality

This page explains how the server turns a file into a stream for each viewer,
what decides the picture each viewer gets, and how to set the bitrate limits
for your upload.

## Copy or re-encode

For each stream, the server either copies the original video or re-encodes it:

| | Copy (Direct Stream) | Re-encode |
|---|---|---|
| Picture | The original, untouched | Encoded again, at up to `VIDEO_BITRATE_KBPS` |
| Server cost | Almost none | GPU or CPU time |
| Each viewer downloads | The file's own bitrate | Up to the re-encode bitrate |

Sound is copied when the player can play it, and converted when it can't, in
either case.

A file is copied when all of these are true:

| Condition | Default |
|---|---|
| Direct Stream is on | `DIRECT_STREAM`, on |
| The player decodes the video: H.264, or HEVC on a player that decodes HEVC. With the FFmpeg engine, also AV1 on a player that decodes AV1. | — |
| The picture is 1080p or smaller (up to 2048 × 1200). 4K files are re-encoded to 1080p. | — |
| The file's average bitrate is within the copy limit | `DIRECT_STREAM_MAX_KBPS`, 25000 |
| The file's average bitrate is within the viewer's chosen quality | Original |
| No subtitle has to be burned into the picture | — |

Otherwise the stream is re-encoded. Other reasons for a re-encode:

| Reason | Why |
|---|---|
| A picture subtitle (PGS, VobSub) is on, with the Plex engine | It can only be burned into the picture. With the FFmpeg engine, each player draws PGS subtitles itself. |
| The file is H.264 from a Blu-ray with open GOPs, with the Plex engine | A copy's segments can't start on a clean frame |
| A copy of the title failed earlier | It stays re-encoded until the server restarts |

Text subtitles (SRT, ASS, WebVTT) are drawn by each player, so they never
prevent a copy.

To see what a stream is, press **I** in the player for **Stats for nerds**. Its
**Playback** row says whether the stream is copied or re-encoded, and why.

## What each player receives

When a player joins, it reports what it can decode: HEVC, AV1, 10-bit video,
HDR, and sound formats. The server gives it a stream it can play:

- A player that can't decode the host's stream gets a version of its own,
  made automatically: H.264 instead of HEVC, SDR instead of HDR, or 8-bit
  instead of 10-bit. Nobody else's stream changes.
- Discord in Firefox can't decode HEVC, so it receives H.264.
- A re-encode is HEVC for a player that decodes HEVC (`HEVC_TRANSCODE`), and
  H.264 otherwise. With the FFmpeg engine, a player that decodes AV1 in
  hardware can receive AV1 (`AV1_TRANSCODE`).

With the Plex engine, HEVC re-encodes need Plex Pass and hardware HEVC
encoding in Plex. Without them, Plex sends H.264.

## Shared and personal streams

Viewers who choose the same audio track, the same burned-in subtitle and the
same quality share one stream. Text subtitles are drawn by each player, so they
don't split a stream.

A viewer who chooses differently gets a stream of their own, and nobody else's
picture changes. Choosing the same tracks and quality as the host puts them
back on the host's stream.

- A viewer's own stream is kept for 15 seconds after they leave, so a quick
  reconnect continues it.
- Streams nobody is watching are stopped after 5 minutes.
- Viewers on the same stream pass segments to each other, peer to peer, which
  reduces your upload. With the [VPS Relay](VPS-Relay), the relay serves
  segments instead.

## Quality

Each viewer chooses a quality in the player's settings menu. The choice
affects only their own stream.

| Quality | Stream |
|---|---|
| Original | A copy when the file can be copied; otherwise a re-encode at `VIDEO_BITRATE_KBPS` |
| 20, 12, 10, 8 or 4 Mbps | A copy if the file's average bitrate fits under it; otherwise a re-encode at that bitrate, at 720p for 4 Mbps |

A choice lasts for the title and the next episodes of its show, through a
pop-out or a short break. After 5 minutes away, it returns to the viewer's
default, which they set in **Settings** on the home page.

When a viewer's connection plainly can't keep up, the player suggests a lower
quality with **Buffering a lot?** and a **Try** button. That takes at least
two separate stalls adding up to 12 seconds within three minutes, while the
connection brings in less than the stream needs. A single long wait, such as
joining or seeking, doesn't count. When a stalled viewer skips ahead of the
room to wait there for the stream, that wait counts as part of the stall. The
suggested quality is the highest that fits in four fifths of what the
connection brought in over those three minutes. The suggestion goes away by
itself once playback runs 8 seconds without a stall with a few seconds
buffered. Closing
it (**Not now**) hides it for 10 minutes.

## Choosing the bitrate limits

| Setting | Default | Controls |
|---|---|---|
| `VIDEO_BITRATE_KBPS` | `20000` | The average bitrate of a re-encode |
| `VIDEO_PEAK_BITRATE_KBPS` | `33000` | The peak bitrate of a re-encode |
| `DIRECT_STREAM_MAX_KBPS` | `25000` | The highest average bitrate a file may have and still be copied |

Every viewer downloads their stream from your server, so divide your upload by
the number of people who usually watch, and set the limits below that figure.
Only the average counts toward the copy limit: a film averaging 18 Mbps with
short peaks above 60 Mbps is still copied under a 25 Mbps limit, because the
players' buffers absorb the peaks.

| Upload per viewer | `VIDEO_BITRATE_KBPS` | `VIDEO_PEAK_BITRATE_KBPS` | `DIRECT_STREAM_MAX_KBPS` |
|---|---|---|---|
| 25 Mbps or more | `20000` | `33000` | `25000` (the defaults) |
| 15 Mbps | `12000` | `20000` | `15000` |
| 10 Mbps | `8000` | `12000` | `10000` |
| 5 Mbps | `4000` | `6000` | `5000` |

Lower limits mean more files are re-encoded instead of copied, which uses more
GPU or CPU time. For larger rooms, the [VPS Relay](VPS-Relay) keeps the
quality and moves the upload to a VPS.

Plex counts the server as a remote player, and applies your remote streaming
limits to it, unless its network is listed under **Settings → Network → LAN
Networks**. See [Plex Setup](Plex-Setup#lan-networks).

## Next

→ [FFmpeg Engine](FFmpeg-Engine) · [Configuration Reference](Configuration-Reference#streaming)
