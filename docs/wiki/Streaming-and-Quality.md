# Streaming and Quality

This page explains how a file becomes a stream for each viewer, what decides
the picture each viewer gets, and how to set the bitrate limits for your
upload.

## The three ways a title plays

| Mode | Video | Audio | Cost to your server |
|---|---|---|---|
| **Direct play** | Sent unchanged | Sent unchanged | Almost none |
| **Direct stream** | Sent unchanged | Converted to a format the player plays | Almost none |
| **Transcode** | Re-encoded | Unchanged or converted | GPU or CPU time |

The server always prefers to send the video unchanged. It transcodes only when
it has to, and only for the viewers who need it.

To see which mode a stream is in, press **I** in the player for **Stats for
nerds**. The **Playback** row says the mode and, for a transcode, the reason.
The [Dashboard](Dashboard) shows the same for every stream in every room.

## When video is sent unchanged

A file's video is sent unchanged when all of these are true:

| Condition | Setting |
|---|---|
| Direct streaming is on | `DIRECT_STREAM`, on by default |
| The viewer's device can play the video codec: H.264, or HEVC where the device plays it. With the [FFmpeg engine](FFmpeg-Engine), also AV1 and VP9. | — |
| For video above 1080p, the device plays that size smoothly | — |
| The file's average bitrate is within your limit | `DIRECT_STREAM_MAX_KBPS`, 25000 by default |
| The file's average bitrate is within the quality the viewer chose | **Original** by default |
| No subtitle has to be burned into the picture | — |

Text subtitles (SRT, ASS, WebVTT) are drawn by each player, so they never
force a transcode.

## When video is transcoded

| Reason | Detail |
|---|---|
| The file is over your bitrate limit | Its average bitrate is above `DIRECT_STREAM_MAX_KBPS` |
| The viewer chose a lower quality | The file doesn't fit under the quality they picked |
| The device can't play the codec | For example, HEVC in Firefox, which gets H.264 |
| The device can't play 4K smoothly | It gets a 1080p stream of its own |
| The file is 10-bit H.264 | Discord's player doesn't play it |
| A picture subtitle is on, with the Plex engine | PGS, VobSub and DVB subtitles can only be burned in by Plex. The FFmpeg engine has each player draw them. |
| A Blu-ray H.264 file with open GOPs, with the Plex engine | Plex's unchanged copy of it doesn't play. The FFmpeg engine sends it unchanged. |
| An earlier attempt to send the title unchanged failed | It stays transcoded until the server restarts |

A transcode is HEVC for a device that plays HEVC (`HEVC_TRANSCODE`, on by
default), and H.264 otherwise. With the FFmpeg engine, a device that plays AV1
in hardware can receive AV1 (`AV1_TRANSCODE`). With the Plex engine, HEVC
transcodes need Plex Pass and hardware HEVC encoding in Plex. Without them,
Plex sends H.264.

## What each viewer receives

When a player joins, it tells the server what it can play: HEVC, AV1, 10-bit
video, 4K, HDR, and audio formats. The server gives it a stream that suits it.

- A viewer whose device can't play the room's stream gets a version of their
  own, made automatically: H.264 instead of HEVC, SDR instead of HDR, 8-bit
  instead of 10-bit, or 1080p instead of 4K.
- Nobody else's stream changes when that happens.
- Audio the player can't play is converted, for that stream only.

## Shared and personal streams

Viewers who have the same audio track and the same quality share one stream.
Subtitles drawn by the player don't split a stream.

A viewer who chooses a different audio track or quality gets a stream of their
own. Choosing the same as the host again puts them back on the host's stream.

- A viewer's own stream is kept for 15 seconds after they leave, so a quick
  reconnect continues it.
- A stream nobody is watching is stopped after 5 minutes.

### How a full room is delivered

Video reaches viewers through Discord's proxy, which caches each piece.
Viewers on the same stream also pass pieces to each other, peer to peer. So the
second and later viewers of a stream get most of their video from Discord's
cache and from each other, not from your server.

The player's **Stats for nerds** shows this under **Peers** and **Discord
cache**. The [Dashboard](Dashboard) shows it for every session, live and in
its history.

## Quality

Each viewer chooses a quality in the player's settings menu. It affects only
their own stream.

| Quality | What they get |
|---|---|
| **Original** | The file unchanged when possible; otherwise a transcode at `VIDEO_BITRATE_KBPS` |
| 20, 12, 10, 8 or 4 Mbps | The file unchanged if its average bitrate fits under that; otherwise a transcode at that bitrate (720p at 4 Mbps) |

A choice lasts for the title and the next episodes of its show, through a
pop-out or a short break. After 5 minutes away, it returns to the viewer's
default, which they set in **Settings** on the home page.

### Buffering a lot?

When a viewer's connection can't keep up, the player suggests a lower quality
with a **Try** button.

- It appears after at least two separate stalls, adding up to 12 seconds
  within three minutes, while the connection brings in less than the stream
  needs. A single long wait, such as joining or seeking, doesn't count.
- It suggests the highest quality that fits in four fifths of what the
  connection managed over those three minutes.
- It goes away by itself once playback runs smoothly again. **Not now** hides
  it for 10 minutes.

## Choosing your bitrate limits

| Setting | Default | Controls |
|---|---|---|
| `VIDEO_BITRATE_KBPS` | `20000` | The average bitrate of a transcode |
| `VIDEO_PEAK_BITRATE_KBPS` | `33000` | The peak bitrate of a transcode |
| `DIRECT_STREAM_MAX_KBPS` | `25000` | The highest average bitrate a file may have and still be sent unchanged |

Set them from your upload speed and how many separate streams you usually
have. Only the average counts toward the direct-play limit: a film averaging
18 Mbps with short peaks above 60 Mbps is still sent unchanged under a 25 Mbps
limit, because the players' buffers absorb the peaks.

| Upload you can spare per stream | `VIDEO_BITRATE_KBPS` | `VIDEO_PEAK_BITRATE_KBPS` | `DIRECT_STREAM_MAX_KBPS` |
|---|---|---|---|
| 25 Mbps or more | `20000` | `33000` | `25000` (the defaults) |
| 15 Mbps | `12000` | `20000` | `15000` |
| 10 Mbps | `8000` | `12000` | `10000` |
| 5 Mbps | `4000` | `6000` | `5000` |

Lower limits mean more files are transcoded, which uses more GPU or CPU time.

> [!NOTE]
> Plex treats the server as a remote player, and applies your remote streaming
> limits to it, unless its network is listed under **Settings → Network → LAN
> Networks**. See [Plex Setup](Plex-Setup#lan-networks).

## Next

→ [FFmpeg Engine](FFmpeg-Engine) · [Configuration Reference](Configuration-Reference#streaming)
