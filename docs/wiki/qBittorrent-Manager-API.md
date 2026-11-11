# qBittorrent Manager API

The server has a private, read-only API for
[plex-qbt-manager](https://github.com/MonkeyGoneWIld/plex-qbt-manager), which
lowers qBittorrent's upload limit while people are watching. The API tells
the manager how many viewers watch each stream, and whether each room is
playing or paused.

Plex remains the manager's source for account identity, and for the bandwidth
of streams Plex transcodes. For streams where Plex has no useful figure, the
server provides its own; see [The server's own figures](#the-servers-own-figures).

## Connect the containers

Choose a long random shared secret, for example with `openssl rand -hex 32`.

In the Theater service:

```yaml
services:
  plex-discord-theater:
    image: ghcr.io/monkeygonewild/plex-discord-theater:2.2.0
    environment:
      QBT_MANAGER_API_KEY: "the-shared-secret"
```

In the manager service:

```yaml
services:
  plex-qbt-manager:
    image: ghcr.io/monkeygonewild/plex-qbt-manager:1.3.0
    environment:
      DYNAMIC_UPLOAD_ENABLED: "true"
      THEATER_URL: "http://plex-discord-theater:3000"
      THEATER_API_KEY: "the-shared-secret"
      THEATER_EXTRA_VIEWER_FACTOR: "0.1"
      THEATER_POLL_INTERVAL_SECONDS: "5"
      THEATER_TIMEOUT_SECONDS: "3"
      THEATER_STALE_SECONDS: "30"
```

- Attach both services to a Docker network on which the manager can resolve
  `plex-discord-theater`.
- Use the same secret on both sides.
- Use HTTPS if the traffic crosses a network you don't trust.
- Recreate both containers after changing these settings.

| Manager setting | Meaning |
|---|---|
| `THEATER_POLL_INTERVAL_SECONDS` | The shortest time between requests to the API. The manager's own `POLLING_INTERVAL` can make it longer. |
| `THEATER_TIMEOUT_SECONDS` | How long one request may take |
| `THEATER_STALE_SECONDS` | How long the last good answer is trusted. After that, the manager counts the Theater's streams as needing nothing until it gets a fresh answer. A failure never drops qBittorrent to its minimum upload limit. |
| `THEATER_SHARED_BASE` | A stream with two or more viewers, in streams' worth of bandwidth, before extra viewers are added. Unset, `1` |
| `THEATER_EXTRA_VIEWER_FACTOR` | What each viewer after the first adds to a shared stream, as a share of the base: `0.1` is 10% more per viewer. Unset, `0.1` |
| `THEATER_MAX_WEIGHT` | The most a shared stream can reserve, in streams' worth of bandwidth. Unset, no limit |
| `THEATER_BANDWIDTH_FACTOR` | The share of each viewer's bandwidth to reserve for a shared stream while neither `THEATER_SHARED_BASE` nor `THEATER_EXTRA_VIEWER_FACTOR` is set |

`THEATER_SHARED_BASE`, `THEATER_EXTRA_VIEWER_FACTOR` and `THEATER_MAX_WEIGHT`
need plex-qbt-manager v1.3.0 or newer. Setting either of the first two turns
the shared estimate on.

## How bandwidth is reserved

Viewers are counted per stream. A viewer counts when their player is open,
including the host and anyone buffering. People who are only browsing, or only
in the voice channel, don't count.

| Viewers on a stream | Reserved |
|---|---|
| None | The previous reservation, for the manager's stop grace period, then nothing |
| One | The stream's bandwidth |
| Two or more | The stream's bandwidth × `THEATER_SHARED_BASE` × (1 + `THEATER_EXTRA_VIEWER_FACTOR` × (viewers − 1)), at most × `THEATER_MAX_WEIGHT`. With neither of the first two set: the stream's bandwidth × viewers × `THEATER_BANDWIDTH_FACTOR` |

Discord's proxy caches each segment for the other viewers it serves, and the
players pass segments to each other, so a stream's later viewers cost your
upload far less than its first. For example, three 20 Mbps streams with 3, 2
and 1 viewers reserve `20×1.2 + 20×1.1 + 20 = 66 Mbps` with a base of 1 and a
factor of 0.1, or `20×3×0.8 + 20×2×0.8 + 20 = 100 Mbps` with only
`THEATER_BANDWIDTH_FACTOR` at 0.8. The manager adds other remote Plex sessions,
then applies its global `BANDWIDTH_MULTIPLIER`.

The manager matches each stream to its Plex session and replaces that row in
its calculation, so the server's streams aren't counted twice and other streams
on the same Plex account are still counted. No Plex user setting is needed.

### The server's own figures

For two kinds of stream, the server reports its own `bandwidth_kbps`, and the
manager uses it instead of Plex's:

- **Video Plex sends unchanged.** Plex's figure for it is how fast it hands
  segments to the server over the LAN, which can be many times the film's
  bitrate, not what a viewer downloads.
- **[FFmpeg engine](FFmpeg-Engine) streams.** Plex lists them without a
  bandwidth. The manager matches their Plex row by `plex_client_id`, so they
  aren't counted twice.

The figure is one number for the whole stream: the file's average bitrate for
video sent unchanged, and the video target plus the audio for a transcode. When the file's
bitrate isn't known, it is the average of the first 30 seconds. Because the
figure doesn't change during the stream, the manager adjusts qBittorrent only
when streams start and stop. A stream without a figure yet counts as needing
nothing; it is never budgeted at the minimum.

These fields are optional additions to schema version 1. The
[integration document](https://github.com/MonkeyGoneWIld/plex-discord-theater/blob/main/docs/qbt-manager-integration.md)
has the details.

## Pauses and failures

The server reports each room's playback state separately from Plex. A pause
in Discord therefore starts the manager's pause grace period, even though Plex
keeps the stream running. State revisions make sure that pauses and resumes
between two manager polls are all seen, and that an older update can't undo a
newer pause.

If Plex stops responding, the manager leaves qBittorrent exactly as it is.
Once `PLEX_STALE_SECONDS` passes, it turns off alternative speeds without
changing the saved alternative upload limit. Normal control resumes when Plex
responds again.

## API reference

```text
GET /api/integrations/qbt-manager/state
Authorization: Bearer <QBT_MANAGER_API_KEY>
```

| Response | Meaning |
|---|---|
| 200 | A snapshot, below |
| 401 | Wrong key |
| 503 | No key is set on the server, or Plex's server identity is unavailable |

The endpoint allows 120 requests per minute and answers with
`Cache-Control: no-store`. Never give the key to the Activity's players or
commit it to a repository.

```json
{
  "schema_version": 1,
  "instance_id": "process-boot-uuid",
  "sequence": 1,
  "plex_server_id": "plex-machine-identifier",
  "delivery_mode": "direct_p2p",
  "streams": [{
    "room_id": "discord-activity-instance",
    "variant_id": "1:0",
    "hls_session_id": "hls-session-uuid",
    "plex_transcode_key": null,
    "rating_key": "42",
    "state": "playing",
    "state_revision": 1,
    "state_age_seconds": 12.5,
    "viewer_count": 3,
    "host_heartbeat_age_seconds": 2.5
  }]
}
```

- Each response is a complete snapshot. Paused streams and streams with no
  viewers are included while they exist; streams of closed rooms are removed.
- `sequence` increases with each response and starts again when
  `instance_id` changes, which happens when the server restarts.
- `delivery_mode` is always `direct_p2p`. It is kept for managers up to
  v1.2.5, which require it; later ones don't read it.
- The response contains no Plex token, no API key and no list of viewers.

To inspect what the manager does with the snapshot (freshness, matching, Plex
account, viewer count, base bandwidth, weight and final budget), set the
manager's `LOG_LEVEL=DEBUG` and open its `/status` page.

## Next

→ [Using the Activity](Using-the-Activity)
