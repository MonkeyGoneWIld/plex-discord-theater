# Replace Plex transcoding with local ffmpeg (Intel QSV) HLS packaging

## Context

Today the entire streaming pipeline depends on **Plex's HLS transcoder**. On playback the
server calls Plex's `/video/:/transcode/universal/{decision,start.m3u8,ping,stop}`
endpoints, extracts Plex's internal transcode key, and then fights Plex's HTTP delivery
throttle with a `/:/timeline` keepalive and a whole segment **pre-fetch** subsystem
(`services/segment-prefetch.ts`). A large fraction of `routes/plex.ts` (~2295 lines) is
workarounds for Plex's stale per-client transcode state (`flushStaleTranscodes`,
`reapOrphanTranscodes`, retry loops, terminate calls).

The goal: **stop using Plex as the transcoder.** Plex stays as the library/metadata source
(browsing, markers, thumbnails, Seerr) and, per the chosen approach, as the **file server** —
ffmpeg reads the *original* media file over HTTP from Plex and transcodes it locally to HLS
using **Intel Quick Sync (QSV)**. This is a **full replacement**: the Plex transcode path and
the throttle-workaround machinery are removed.

Why this is tractable: the client is already format-agnostic HLS (hls.js + p2p-media-loader).
It only needs a `master.m3u8`, `.ts` segments over the existing `/api/plex/hls/seg` route, a
ping (keepalive) endpoint, and a stop endpoint. If our ffmpeg packager produces the same URL
shapes, **VPS relay and P2P keep working unchanged** and the client barely changes.

Decisions locked in: source = **Plex download URL** (`plexUrl(part.key)`); hardware = **Intel
QSV** (`/dev/dri`); scope = **full replacement**.

## Key facts established during exploration

- HLS entry route: `packages/server/src/routes/plex.ts:1439`
  `GET /hls/:ratingKey/:sessionId/master.m3u8?offset=&subtitles=`. `fetchManifest()`
  (`plex.ts:1497`) does decision→start→extract-key→prefetch→timeline→rewrite. All Plex-specific.
- Segment proxy: `plex.ts:1731` `GET /hls/seg?p=<encoded>`; ping `plex.ts:1870`; stop (DELETE
  session) `plex.ts:1945`. Cleanup timers `reapOrphanTranscodes` (`plex.ts:1144`),
  `flushStaleTranscodes` (`plex.ts:1299`), plus module maps `plexTranscodeKeys`,
  `activeTranscodeKeys`, `allKnownPlexKeys`, `transcodeHead`, `hostPingInfo`, `manifestCache`.
- Plex HTTP client: `services/plex.ts` — `plexUrl(path)` appends `X-Plex-Token`. Reused as-is
  to build the ffmpeg **input URL** and to fetch metadata.
- Source file + tracks come from `/library/metadata/:ratingKey`: `PlexPart` (`plex.ts:84`) has
  `id` and (in the raw API) `key` = `/library/parts/<id>/<ts>/file.<ext>` → the original file.
  `PlexStream` (`plex.ts:71`) has Plex `id`, `streamType` (1 video / 2 audio / 3 subtitle),
  `selected`, `codec`, `language`. **`index` (the container/ffmpeg stream index) is not yet on
  the interface — add it**; it's what `-map 0:<index>` needs.
- Track selection today: `PUT /streams/:partId` (`plex.ts:825`) → Plex, then client restarts
  the transcode. Subtitles are **burned in** (`subtitles=burn`).
- Client URL builders: `packages/client/src/lib/api.ts` — `hlsMasterUrl` (`api.ts:329`), ping
  (`api.ts:366`), stop (`api.ts:370`). Player buffer/seek logic in
  `packages/client/src/components/Player.tsx` (HLS effect `:358`, far-seek restart `:882`).
- The P2P `highDemandTimeWindow/p2pDownloadTimeWindow/httpDownloadTimeWindow = 150 (> maxBuffer
  120)` fix in `Player.tsx:463` is a **client-side hls.js/p2p-media-loader** fix, independent of
  Plex — **it stays**. Only the *server* prefetch that was "matched" to it goes away.

## Approach

### 1. New service: `packages/server/src/services/ffmpeg-transcoder.ts`

Owns everything Plex used to own on the transcode side. In-memory
`Map<sessionId, FfmpegSession>`:

```
FfmpegSession = { proc: ChildProcess, dir: string, generation: number,
                  ratingKey, offsetSec, audioIndex?, subIndex?, subBurn: bool,
                  startedAt, lastPing }
```

Exports:
- `resolveSource(ratingKey)` → `{ fileUrl, durationMs, streams }` via `plexJSON('/library/metadata/'+ratingKey)`; `fileUrl = plexUrl(part.key)`. Cache per ratingKey.
- `startTranscode({ sessionId, ratingKey, offsetSec, audioIndex, subIndex, subBurn })`:
  kills any existing proc for the session, creates `dir = <TRANSCODE_TMP>/<sessionId>/<generation>/`,
  spawns ffmpeg (args below), records the session. Resolve once `index.m3u8` + first `.ts`
  exist (poll the dir, ~5s timeout) — or synthesize the master immediately and let hls.js
  poll the growing media playlist. Prefer the latter (matches Plex's cold-start behavior).
- `stopTranscode(sessionId)`: `proc.kill('SIGKILL')`, `rm -rf` the session dir.
- `readSegment(sessionId, name)`: path-validated read from the live generation dir; ENOENT →
  caller returns 404 (client is ahead of the encoder head — same semantics as today).
- `buildMediaPlaylist(sessionId)` / `buildMasterPlaylist(sessionId)`: read ffmpeg's
  `index.m3u8`, rewrite bare `NNNNN.ts` → the proxied/VPS segment URL (reuse the existing
  `rewriteManifestUrls` logic), and synthesize a one-variant master pointing at it.
- Reaper (60s) + `stopAll()` on shutdown. Replaces `reapOrphanTranscodes`/`stopAllActiveSessions`.

**ffmpeg args (QSV, encoder flags env-selected via `HW_ACCEL=qsv|vaapi|software`):**

```
ffmpeg -hide_banner -loglevel warning
  -init_hw_device qsv=hw -filter_hw_device hw
  -ss <offsetSec>                       # fast input seek; omit when 0
  -reconnect 1 -reconnect_streamed 1 -reconnect_delay_max 5   # robust HTTP input
  -i "<plexFileUrl>"
  -map 0:v:0 -map 0:a:<audioIndex|0>
  <video filter chain>                  # scale to <=1080p (+ subtitle burn, see §4)
  -c:v h264_qsv -b:v <VIDEO_BITRATE_KBPS>k -maxrate <VIDEO_PEAK_BITRATE_KBPS>k -bufsize ...
  -c:a aac -b:a 256k -ac 2
  -force_key_frames "expr:gte(t,n_forced*3)"   # clean 3s GOP boundaries
  -f hls -hls_time 3 -hls_playlist_type event
  -hls_segment_type mpegts -hls_flags independent_segments+temp_file
  -hls_segment_filename "<dir>/%05d.ts" "<dir>/index.m3u8"
```

- `-hls_playlist_type event` → the playlist **grows** as segments encode and gets
  `#EXT-X-ENDLIST` at completion. This mirrors Plex's linear-transcode model exactly, so the
  client's far-seek-restart and buffer-window logic stay valid.
- **Do not use `-copyts`**: each restart's playlist should start at t=0, matching Plex's
  per-restart-from-zero behavior that `Player.tsx`'s "session start offset" seek math assumes.
  (Verify against `handleSeekRestart` at `Player.tsx:882`.)
- Reuse existing `VIDEO_BITRATE_KBPS` / `VIDEO_PEAK_BITRATE_KBPS` env.

### 2. Rewire the HLS routes in `routes/plex.ts` (remove Plex, call the service)

- `master.m3u8` (`plex.ts:1439`): keep the route + validation + reuse/in-flight-dedup shape,
  but replace `fetchManifest()`'s decision/start/key-extract/timeline body with
  `startTranscode(...)` + `buildMasterPlaylist(...)`. Reuse-when-alive keys on "is the ffmpeg
  proc for this session running" instead of `activeTranscodeKeys`. An `?offset=` request =
  seek-restart (bumps `generation`).
- `hls/seg` (`plex.ts:1731`): the `p` param now encodes `<sessionId>/<segmentName>` (or the
  media sub-playlist). Serve from disk via `readSegment` instead of `plexFetchSegment`. **Keep
  the route path and the `?key=` VPS bypass identical** so the VPS nginx rule
  (`/theater/seg → /api/plex/hls/seg?p=`) and `segProxyUrl` (`plex.ts:2203`) need no change.
- `ping` (`plex.ts:1870`): reduce to `lastPing = now` (keepalive for the reaper). Drop the
  Plex `ping` + `/:/timeline` + stall-nudge logic (no throttle to fight). Client keeps calling
  it unchanged.
- stop `DELETE .../session/:sessionId` (`plex.ts:1945`): call `stopTranscode`. Drop
  `terminatePlexSession`/`notifyPlexStopped`.
- **Delete** the Plex-transcode machinery: `flushStaleTranscodes`, `reapOrphanTranscodes`, the
  transcode-key maps, and retire `services/segment-prefetch.ts` entirely (its only purpose was
  the Plex throttle). Keep `mediaDurations` if still convenient, else fold into `resolveSource`.

### 3. Track selection (audio + subtitles) via ffmpeg `-map`

Recommended: **pass selection on the master URL** instead of the stateful Plex PUT.
- Extend `hlsMasterUrl` (`api.ts:329`) to append `&audio=<streamIndex>&sub=<streamIndex|off>`.
- Add `index` to `PlexStream` (`plex.ts:71`) and surface it wherever streams are sent to the
  client (the metadata mapper around `plex.ts:679`) so the client can pass the ffmpeg index.
- `startTranscode` maps `-map 0:a:<n>`; subtitle → burn filter (§4).
- Replace `PUT /streams/:partId` (`plex.ts:825`): it no longer talks to Plex. Either delete it
  and have the client just re-request the master with new params (it already restarts on track
  change), or keep it as a thin "store selection for session" no-op. Prefer deletion + master
  params for less state. Touch points client-side: `setStreams` in `api.ts`, the track-select
  handlers in `Player.tsx`.

### 4. Subtitle burn-in (the one genuinely hard part under QSV)

Hardware frames can't be fed straight to the `subtitles`/`overlay` filter. For a burned sub:
- Text subs (SRT/ASS): `... hwdownload,format=nv12, subtitles='<fileUrl>':si=<n>, hwupload=extra_hw_frames=64, scale_qsv=... , h264_qsv`, i.e. round-trip to system memory for the burn.
- Image subs (PGS/VOBSUB): `overlay` the decoded subtitle stream similarly.
- Simplest first cut: when a sub is selected, **do scale + burn in software and QSV-encode
  only** (`-c:v h264_qsv` with a software filter chain); use full QSV (`scale_qsv`) only when
  no sub is burned. Optimize later. Flag this as the highest-risk sub-task to validate early.

### 5. Docker / runtime (QSV)

- Dockerfile: base the runtime stage on an image with QSV-capable ffmpeg — **jellyfin-ffmpeg**
  is the pragmatic choice (ships oneVPL/QSV/VAAPI). Add `FFMPEG_PATH` env (default the bundled
  binary).
- `docker-compose.yml`: pass the iGPU — `devices: ["/dev/dri:/dev/dri"]` and add the container
  user to the `render`/`video` groups (`group_add`).
- New env: `HW_ACCEL` (qsv|vaapi|software), `FFMPEG_PATH`, `TRANSCODE_TMP` (default OS tmp).
  Document in `.env.example` and README's "Transcode Configuration" table (replace the Plex
  settings table with ffmpeg equivalents).

## What stays untouched

- Client hls.js + p2p-media-loader, **including the 150s window fix** (`Player.tsx:463`).
- VPS relay (`segProxyUrl`, nginx config, `docs/vps-relay-setup.md`) — segment URL scheme preserved.
- P2P tracker (`services/tracker.ts`, `sync.ts`), WebSocket sync, auth (`middleware/auth.ts`).
- All Plex **browsing/metadata/markers/thumbnails** and Seerr.

## Critical files

- **New:** `packages/server/src/services/ffmpeg-transcoder.ts`
- **Heavily edited:** `packages/server/src/routes/plex.ts` (HLS routes + delete Plex transcode machinery)
- **Deleted/retired:** `packages/server/src/services/segment-prefetch.ts`
- **Small edits:** `packages/client/src/lib/api.ts` (master URL params), `packages/client/src/components/Player.tsx` (track-select → master params), `Dockerfile`, `docker-compose.yml`, `.env.example`, `README.md`
- **Reused as-is:** `packages/server/src/services/plex.ts` (`plexUrl`/`plexJSON`)

## Verification

1. **QSV present:** in the container, `ffmpeg -init_hw_device qsv=hw -f lavfi -i testsrc -t 1 -c:v h264_qsv -f null -` succeeds; `/dev/dri/renderD128` exists.
2. **Encoder arg builder:** unit-test the QSV/VAAPI/software flag builder for offset, audio map, and sub-burn permutations.
3. **End-to-end (browser preview tools):** start the server against a real Plex library →
   request `master.m3u8` → confirm an ffmpeg process spawns, `index.m3u8` + `.ts` files appear
   in `TRANSCODE_TMP`, and hls.js plays. Watch `read_console_messages` / `preview_logs` for HLS errors.
4. **Seek:** far-seek → old ffmpeg killed, new generation dir, playback resumes at target.
5. **Tracks:** switch audio and toggle a burned subtitle → transcode restarts with correct `-map`/burn.
6. **Lifecycle:** stop → proc killed + dir removed; kill the host and confirm the 60s reaper
   cleans the session; server shutdown kills all ffmpeg.
7. **Perf:** during a 1080p session, `intel_gpu_top` shows GPU video-engine load and host CPU
   stays low (proves QSV, not libx264). Run 2 concurrent sessions.
8. **Regression:** VPS relay mode still serves segments (URL scheme unchanged); P2P mesh still
   forms with no VPS.
