# qBittorrent upload budgeting

Use this branch with `plex-qbt-manager` branch `feature/dynamic-upload-limits`.
Both services should share the internet connection whose upload is being budgeted.

Set `QBT_MANAGER_API_KEY` in Theater to a long random secret. Set the manager's
`THEATER_API_KEY` to the same value and `THEATER_URL` to Theater's server URL,
for example `http://plex-discord-theater:3000` on a shared Docker network.
Use HTTPS if the connection crosses an untrusted network. Restart services after
changing environment settings. An empty Theater key disables the endpoint.

The manager also accepts:

```dotenv
DYNAMIC_UPLOAD_ENABLED=true
THEATER_BANDWIDTH_FACTOR=0.8
THEATER_POLL_INTERVAL_SECONDS=5
THEATER_TIMEOUT_SECONDS=3
THEATER_STALE_SECONDS=30
```

The factor estimates P2P savings **only for variants with at least two viewers**.
A single-viewer variant always reserves one Plex stream's bandwidth. For three
12 Mbps variants with 3, 2 and 1 viewers, factor 0.8 gives
`12×3×0.8 + 12×2×0.8 + 12 = 60 Mbps`. The manager adds ordinary remote Plex
bandwidth, applies its global `BANDWIDTH_MULTIPLIER`, and converts Mbps to MiB/s
for the upload budget. Viewer counts measure connected users with the player
open, including host and buffering viewers; browsing/voice-only users do not
count. Counts are per audio/subtitle variant, not per room total.

Theater's `VPS_RELAY_URL` determines delivery mode. When set, the manager reserves
one home-upload feed per occupied variant, without the per-viewer P2P factor.
Leave relay off for direct P2P delivery. The factor is an estimate, not measured
P2P traffic; it can be tuned independently of the global bandwidth multiplier.

The manager obtains account identity and bandwidth from Plex with its existing
token. It matches the real Plex server ID and exact HLS session ID or transcode
key before filtering LAN sessions. It replaces the matched Plex reservation,
so the bot is not counted twice; ordinary streams by the same Plex account are
still counted. No manual account mapping is required.

Pauses are taken from Theater's room transport state. Plex's intentional
keep-playing timeline behavior is unchanged. Transport revisions and monotonic
state age survive repeated pause/resume cycles between manager polls. Host
heartbeats acknowledge the last transport revision applied to the video element;
stale heartbeats cannot undo a newer cohost pause. Older clients remain supported
by a matching-state acknowledgment fence after cohost commands.

The manager holds paused bandwidth for its pause grace, and zero-viewer bandwidth
for its stop grace. A stale Theater connection selects the minimum upload budget
while Plex remains reachable. A Plex outage instead freezes qBittorrent settings
until `PLEX_STALE_SECONDS` (default 120), then disables alternative mode without
changing its saved upload preference. Both recover automatically.

## Private protocol

`GET /api/integrations/qbt-manager/state` requires `Authorization: Bearer <key>`.
It is read-only, has its own 120-requests/minute rate limit, uses no browser
session, and sends `Cache-Control: no-store`. An unset key or unavailable initial
Plex server identity returns 503; a wrong key returns 401. The real authenticated
Plex server identity is cached for this process's lifetime; restart Theater if
you change its Plex server. No Plex token, integration key or viewer user list
is included in snapshots.

Schema version 1:

```json
{
  "schema_version": 1,
  "instance_id": "process-boot-uuid",
  "sequence": 1,
  "plex_server_id": "real-plex-machine-identifier",
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

Live paused and zero-viewer variants remain in the full snapshot. Removed rooms
disappear. Sequence increases on every response and resets with a new boot UUID.
State age changes only on actual playing/paused transitions; heartbeat age has
its own clock. A transcode key can be null until Plex's manifest resolves it.

Use manager `LOG_LEVEL=DEBUG` and `/status` to see matching Plex account IDs,
viewer counts, base bandwidth, applied weight, reservations and integration
freshness. Theater logs transport revisions and rejected stale host heartbeats.
Publishing this branch does not update running containers or the `latest` image;
build the checked-out source when you are ready to deploy it.
