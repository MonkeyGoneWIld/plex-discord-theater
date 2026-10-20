# qBittorrent Manager API

Plex Discord Theater v1.0.3 exposes a private, read-only API for
[`plex-qbt-manager`](https://github.com/MonkeyGoneWIld/plex-qbt-manager). It tells
the manager how many connected viewers use each audio/subtitle stream and whether
the Discord room is playing or paused. Plex remains the source of account
identity, and of bandwidth for the streams Plex re-encodes. For the streams it
can't give a useful figure for, Theater gives its own: see
[Theater's own figures](#theaters-own-figures).

## Connect the containers

Choose a long random shared secret. In the Theater service:

```yaml
services:
  plex-discord-theater:
    image: ghcr.io/monkeygonewild/plex-discord-theater:1.0.3
    environment:
      - QBT_MANAGER_API_KEY=replace-with-the-shared-secret
```

In the manager service:

```yaml
services:
  plex-qbt-manager:
    image: ghcr.io/monkeygonewild/plex-qbt-manager:1.0.0
    environment:
      DYNAMIC_UPLOAD_ENABLED: "true"
      THEATER_URL: "http://plex-discord-theater:3000"
      THEATER_API_KEY: "replace-with-the-shared-secret"
      THEATER_BANDWIDTH_FACTOR: "0.8"
      THEATER_POLL_INTERVAL_SECONDS: "5"
      THEATER_TIMEOUT_SECONDS: "3"
      THEATER_STALE_SECONDS: "30"
```

Both services must be attached to a Docker network on which the manager can
resolve `plex-discord-theater`. Use the same secret on both sides. Use HTTPS if
traffic crosses an untrusted network. Recreate both containers after changing
the configuration.

`THEATER_POLL_INTERVAL_SECONDS` is the minimum interval between Theater API
requests. The manager's own `POLLING_INTERVAL` can make it slower.
`THEATER_TIMEOUT_SECONDS` limits how long one Theater request may take.
`THEATER_STALE_SECONDS` controls how long the last successful snapshot remains
trusted: the manager keeps the last reservation that long, then counts the
Theater streams as needing nothing until fresh data arrives. A failure never
drops qBittorrent to its minimum upload limit.

## Bandwidth calculation

Viewer counts are per audio/subtitle variant. Connected users with the player
open count, including the host and buffering viewers. People only browsing or
sitting in voice do not count.

- One viewer reserves the Plex bandwidth once. The Theater factor is not used.
- Two or more viewers reserve `Plex bandwidth × viewers × THEATER_BANDWIDTH_FACTOR`.
- Zero viewers retain the previous reservation for the manager's stop grace, then release it.

For three separate 12 Mbps variants with 3, 2 and 1 viewers and a Theater factor
of 0.8, the Theater total is `12×3×0.8 + 12×2×0.8 + 12 = 60 Mbps`. The manager
adds ordinary remote Plex sessions and applies its global `BANDWIDTH_MULTIPLIER`
afterward.

The manager matches each variant to the exact Plex HLS session or transcode key,
then replaces that Plex row in its calculation. This prevents the Theater bot
account from being counted twice without excluding unrelated streams that use
the same Plex account. No manual Plex user setting is required.

When `VPS_RELAY_URL` is enabled, each occupied variant uses one home-upload feed;
the direct P2P viewer multiplier is not applied.

### Theater's own figures

Two kinds of stream carry Theater's own `bandwidth_kbps`, and the manager uses it
in place of Plex's:

- **Direct Stream copies.** Plex's figure for a copy is how fast it hands the
  segments to Theater over the LAN, ahead of the watchers (121 Mbps for a 1 to
  5 Mbps film, in one test), not what a viewer downloads.
- **[FFmpeg engine](FFmpeg-Engine) streams.** Plex lists them with no bandwidth.
  The manager claims their Plex row by `plex_client_id`, so it is not counted
  twice.

The figure is one number for the whole stream, as Plex gives one for each of
its own: the file's average for a copy, the video target plus the audio for a
re-encode. When the file's bitrate isn't known, it is the average of the first
30 s, kept for the rest of the stream. It doesn't follow the film's bitrate as
it plays, so the manager only changes qBittorrent's limit when streams start
and stop. A stream without a figure yet counts as needing nothing; it is never
budgeted at the minimum.

The keys are optional and additive (the schema stays version 1); the
[integration doc](https://github.com/MonkeyGoneWIld/plex-discord-theater/blob/main/docs/qbt-manager-integration.md)
has the details.

## Pause and failure behavior

Theater reports room playback separately from Plex. A Discord pause therefore
starts the manager's pause grace even though Plex intentionally continues the
transcode. Transport revisions distinguish pause/resume/pause transitions that
happen between manager polls and prevent an old host heartbeat from undoing a
newer co-host pause.

If Plex stops responding, the manager freezes qBittorrent exactly as it is. Once
`PLEX_STALE_SECONDS` expires, it disables alternative speeds without changing the
saved alternative upload value. Normal control resumes with fresh Plex data.

## API contract

The endpoint is:

```text
GET /api/integrations/qbt-manager/state
Authorization: Bearer <QBT_MANAGER_API_KEY>
```

It has a dedicated 120-requests-per-minute limit and returns
`Cache-Control: no-store`. An unset key returns 503, a wrong key returns 401, and
an unavailable Plex server identity returns 503. Never expose this key to the
Activity client or commit it to the repository.

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

The response is a full snapshot. Paused and zero-viewer live variants remain
present; removed rooms disappear. Sequence increments per response and resets
when `instance_id` changes. The payload contains no Plex token, integration key,
or viewer user list.

Use manager `LOG_LEVEL=DEBUG` and `/status` to inspect snapshot freshness,
matching, Plex account, viewer count, base bandwidth, weight and final budget.
