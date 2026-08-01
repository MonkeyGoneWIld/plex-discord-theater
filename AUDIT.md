# plex-discord-theater — full code audit

Reviewed at `677288e` (main). ~21k lines across `packages/server` and `packages/client`, plus
Docker/env/CSP config. Both packages typecheck clean (`tsc --noEmit`), so nothing here is a
compile error — these are runtime, config, performance and UX defects.

Every item below was verified against the source (file:line given). Where I am inferring
behaviour rather than having observed it, I say so explicitly.

---

## 1. Broken right now

### 1.1 The cache warmer never warms anything it claims to — every request 401s
`packages/server/src/services/cache-warmer.ts:70`

```js
const res = await fetch(`http://127.0.0.1:${port}/api/plex/collections/${ratingKey}`);
```

No `Authorization` header. `/api/plex` is mounted behind `requireAuth`
(`packages/server/src/index.ts:149`), so every one of these returns 401. The response status is
never checked and `warmed++` (line 86) counts it as a success, so the startup line
`[warm] cached 600/600 titles` is reporting work that did not happen. `buildMeta` (called
in-process on line 84) does work; the collections/recommendations half — the expensive half, the
one the module's own docstring says is the reason it exists — does not. Detail pages still pay the
full Plex + TMDB round trip on first open.

**Fix.** Factor the `/collections/:ratingKey` body out of the route into an exported
`buildRelated(ratingKey)` and call it directly, the way `buildMeta` already is. That also removes
the HTTP hop entirely (and with it the warmer eating 600 of the general rate limiter's 600-per-15-min
budget from 127.0.0.1). If you'd rather keep the loopback call, mint an internal session at boot
via `createSession()` and send it as a Bearer token.

### 1.2 `terminatePlexSession` doesn't use the token its own comment says it uses
`packages/server/src/routes/plex.ts:2218-2222`, `packages/server/src/services/plex.ts:16`

```js
// /status/sessions/terminate needs an account-privileged token — the server
// PLEX_TOKEN gets 403'd, leaving the session (and its transcode) to linger.
// Use PLEX_ACCOUNT_TOKEN when set (same one Discover/Seerr use).
const termRes = await plexFetch("/status/sessions/terminate", termParams, undefined, "POST");
```

`plexFetch` → `plexUrl` unconditionally sets `X-Plex-Token` to `process.env.PLEX_TOKEN`. There is
no code path by which `PLEX_ACCOUNT_TOKEN` reaches this call. So the 403 the comment describes is
still happening on every setup, including ones that configured the account token specifically to
avoid it — and `flushStaleTranscodes` (line 2388) names `terminatePlexSession` as *"the mechanism
that actually reaps these"*. Orphan transcodes accumulate on Plex.

**Fix.** Add an optional token override:

```ts
export function plexUrl(path, params?, token = process.env.PLEX_TOKEN!) { … }
export function plexFetch(path, params?, headers?, method?, token?) { … }
```

and pass `process.env.PLEX_ACCOUNT_TOKEN || process.env.PLEX_TOKEN` from `terminatePlexSession`.
The warning on line 2224 that prints `(no PLEX_ACCOUNT_TOKEN set)` becomes truthful at the same time.

### 1.3 HTTP teardown leaks the prefetcher and two maps
`packages/server/src/routes/plex.ts:3062-3084`

The `DELETE /api/plex/hls/session/:sessionId` handler clears state by hand:

```js
activeTranscodeKeys.delete(plexKey);
plexTranscodeKeys.delete(sessionId);
sessionRatingKeys.delete(sessionId);
```

It never calls `markTranscodeStopped()` (line 2021), which is the function that also does
`stopPrefetch(sessionId)`, `transcodeHead.delete(plexKey)` and `hostPingInfo.delete(sessionId)`.
The WebSocket path (`services/sync.ts:54`) *does* call it; the HTTP path doesn't. Consequences:

- the prefetch poll timer keeps hitting Plex's sub-manifest every 2 s until it happens to 404
  (`segment-prefetch.ts:210`), holding up to 100 buffered segments alive the whole time;
- `MAX_CONCURRENT_SESSIONS = 2` (`segment-prefetch.ts:270`), so one or two lingering sessions make
  `startPrefetch` refuse to start for the *next* real session — silently, with only a
  `console.warn`. That turns into "the next thing I played buffered badly for no reason".

**Fix.** Replace the three manual deletes with `markTranscodeStopped(sessionId)`.

### 1.4 CSP blocks five of the six ratings icons
`packages/server/src/index.ts:58` — `imgSrc: ["'self'"]`

Vite inlines any imported asset under `assetsInlineLimit` (default 4096 B) as a `data:` URI. In
`packages/client/src/assets/rt/`:

| file | bytes | inlined? |
|---|---:|---|
| tomato-rotten.svg | 833 | yes |
| popcorn-fresh.svg | 1369 | yes |
| tomato-fresh.svg | 1443 | yes |
| tmdb.svg | 2577 | yes |
| imdb.svg | 4010 | yes |
| popcorn-spilled.svg | 4707 | **no** |

`RatingsRow.tsx:68-87` renders all of them with `<img src={…}>`. Under `img-src 'self'` the five
`data:` ones are blocked and render as broken images; the one that stayed a real file works. That
asymmetry is the tell if you want to confirm it visually.

**Fix.** `imgSrc: ["'self'", "data:"]`. (Or `build.assetsInlineLimit: 0` in `vite.config.ts` — but
allowing `data:` for images is the normal choice and costs nothing.)

### 1.5 CSP has no `blob:`, which hls.js needs in two places
`packages/server/src/index.ts:54, 57`

hls.js 1.6.16 does both of these:

- `media.src = self.URL.createObjectURL(ms)` — `node_modules/hls.js/dist/hls.js:19305`. That is a
  `blob:` URL assigned to a `<video>`, which `media-src` governs. Current value is
  `["'self'", vpsRelayOrigin]`.
- `new self.Worker(URL.createObjectURL(blob))` for the transmuxer —
  `node_modules/hls.js/dist/hls.js:17123`. Governed by `worker-src`, falling back to `child-src`
  then `script-src`, which is `["'self'"]`. hls.js catches this failure and silently degrades to
  demuxing on the **main thread** — no error surfaces, playback just gets janky.

**Fix.** `mediaSrc: ["'self'", "blob:", …vps]` and add `workerSrc: ["'self'", "blob:"]`.

**Caveat, stated plainly:** if playback works for you today, the `media-src` half is being masked —
most likely Discord's activity proxy is rewriting or dropping the header on the way to the iframe.
I did not observe the live embed. The directives are wrong regardless of whether something is
currently papering over them, and adding `blob:` is safe either way; the worker degradation is
real independent of that.

### 1.6 A client that reconnects cannot learn it was promoted to host
`packages/client/src/hooks/useSync.ts:257-275`

The `"state"` handler (the reply to `join`) derives `isCoHost` from the participants roster but
never touches `isHost`, and the server's state message has no top-level `isHost` field either
(`services/sync.ts:469-482`). So: host's socket drops → server promotes a successor
(`sync.ts:812-821`) → if that successor's own socket also blipped, its reconnect gets a `state`
message whose roster says `isHost: true` for them, and the client ignores it. They sit there as a
"viewer" with no transport controls, unable to drive a room they own. `state.isHost` stays `null`
and `effectiveIsHost` falls back to the boot-time value from `useDiscord`.

**Fix.** One line, next to the existing `isCoHost` derivation:

```ts
isHost: ((msg.participants as Participant[]) || []).find(p => p.userId === userId)?.isHost
        ?? prev.isHost,
```

### 1.7 On a touchscreen there is no way to get the controls back
`packages/client/src/components/Controls.tsx:228-244, 625-626, 633`

The hide timer is reset by exactly one thing: a `mousemove` listener on
`videoRef.current.parentElement.parentElement`. While hidden, the control bar is
`pointerEvents: "none"`, so a tap passes through to the `<video>`'s `onClick` →
`togglePlayPause`. On a phone — where Discord Activities very much run — the controls vanish after
3 s and every subsequent tap pauses or resumes rather than revealing them. There is no
`touchstart`/`pointerdown` path anywhere in the file (the only `pointer*` handlers are on the scrub
bar itself, which is already hidden).

**Fix.** Add `pointerdown` (and `touchstart`) on the same container to `resetHideTimer`, and make
the video's tap handler reveal-if-hidden / toggle-if-visible rather than always toggling.

Related fragility worth fixing at the same time: `parentElement.parentElement` silently resolves to
nothing if anyone adds a wrapper div in `App.tsx`, and the controls would then never auto-hide with
no error. Use a ref on the player container instead.

### 1.8 A malformed client log batch 500s the whole endpoint
`packages/server/src/routes/logs.ts:64-65`

```js
const rawT = Number.isFinite(entry.t) ? (entry.t as number) : Date.now();
const when = new Date(rawT + skewMs);
… `${when.toISOString()}` …
```

`Number.isFinite` rejects `NaN`/`Infinity` but not out-of-range values. `t: 1e20` is finite, gives
an Invalid Date, and `toISOString()` throws `RangeError` — Express catches the synchronous throw and
returns 500, losing the whole batch. Also: `msg` is written into the file verbatim including
newlines, so a client can forge log lines.

**Fix.** `const when = new Date(rawT + skewMs); if (Number.isNaN(when.getTime())) when = new Date();`
and strip `[\r\n]` from `msg`/`tag` before writing.

### 1.9 The History tab doesn't refresh when you come back to it
`packages/client/src/components/Library.tsx:163-182`

The Continue Watching effect has `visible` in its dependency array. The History effect immediately
below reads `visible` in its guard but its deps are `[isHistoryTab, retryNonce, historyNonce]` —
no `visible`. Returning from a detail or player view therefore leaves the History tab showing
pre-playback positions, which is precisely what its own comment ("same refresh discipline") says it
avoids.

**Fix.** Add `visible` to the deps.

### 1.10 docker-compose drops most of the documented configuration
`docker-compose.yml`

Documented in `.env.example`, never forwarded into the container:
`MDBLIST_API_KEY`, `ADMIN_SECRET`, `VIDEO_BITRATE_KBPS`, `VIDEO_PEAK_BITRATE_KBPS`,
`WARM_CACHE`, `WARM_CACHE_MAX_ITEMS`, `WARM_CACHE_DELAY_MS`, `WARM_CACHE_INTERVAL_MIN`,
`LOG_TO_FILE`, `LOG_DIR`, `LOG_MAX_FILE_MB`, `LOG_RETENTION_DAYS`,
`THUMB_CACHE_TTL_MS`, `THUMB_CACHE_MAX_MB`.

The most user-visible consequence: someone sets `MDBLIST_API_KEY` in `.env`, follows the
docker-compose path (the supported one), and the entire ratings row stays dead with no error —
`/api/ratings` just answers `configured: false`. `VIDEO_BITRATE_KBPS` is described in the code as
"the single biggest bandwidth lever" and is equally unreachable.

Conversely, compose passes `SESSION_SECRET`, which nothing in the codebase reads.

**Fix.** Add the missing pass-throughs; drop `SESSION_SECRET`.

---

## 2. Performance

### 2.1 The thumbnail cache does two full table scans on every write
`packages/server/src/services/thumb-cache.ts:69-82`

```js
export function set(thumbPath, contentType, data) {
  stmtSet.run(…);
  stmtDeleteExpired.run(Date.now() - TTL_MS);   // no index on cached_at → full scan
  let { total } = stmtTotalSize.get();          // SUM(LENGTH(data)) → full scan of the BLOBs
  while (total > MAX_BYTES) { … }
}
```

The table holds up to 500 MB of image BLOBs (`DEFAULT_MAX_MB = 500`), there is no index on
`cached_at`, and better-sqlite3 is **synchronous** — this runs on the event loop of a server whose
main job is proxying video segments. A cold 200-item library page stores ~200 posters, so that's
~200 sequential full scans of a half-gigabyte table, interleaved with HLS segment proxying.

This is the single biggest performance win available in the codebase.

**Fix.**
1. `CREATE INDEX IF NOT EXISTS idx_thumbs_cached_at ON thumbs(cached_at);`
2. Keep the total byte count in a module variable, seeded once at startup and adjusted by
   `data.length` on insert and by `changes × avg` (or a returned SUM) on evict.
3. Run the expired-sweep on a timer (say every 10 min), not per write.

### 2.2 Segment prefetch is bounded by count, not bytes
`packages/server/src/services/segment-prefetch.ts:47`

`MAX_CACHE_SIZE = 100` segments × 3 s each. At the 12 Mbps target that's ~4.5 MB per segment
(~450 MB); at the 20 Mbps peak ceiling, ~7.5 MB (~750 MB). Times `MAX_CONCURRENT_SESSIONS = 2`.
Nothing in the module measures bytes.

**Fix.** Track `cachedBytes` and evict against a byte budget (e.g. 256 MB total across sessions).

Related, smaller: `evictIfNeeded` (line 121) guards the second pass with
`if (session.segmentCache.size >= MAX_CACHE_SIZE)`, so with nothing marked `served` the cache sits
between 51 and 99 entries doing no eviction at all until it hits exactly 100. Should be
`> EVICTION_THRESHOLD`.

### 2.3 Nine module-level caches that never evict
`packages/server/src/routes/plex.ts`

`metaCache` (837), `relatedCache` (846), `ownedGuidCache` (569), `tmdbIdCache` (615),
`libraryMatchCache` (1097), `tmdbPersonCache` (1636), `tmdbMovieCollectionCache` (995),
`tmdbCollectionCache` (996), `mediaDurations` (1910). Plus `cache` in `routes/ratings.ts:47`.

All of them check a TTL on *read*, and none of them ever removes an entry. They grow with the
number of distinct titles, searches, people and TMDB ids the server has ever seen, and only shrink
on restart. The cache warmer pins 600 `metaCache` + 600 `relatedCache` entries on its own; a
`libraryMatchCache` entry is a whole `PlexMetadataItem`.

The right pattern is already in this repo — `services/watch-history.ts:318-321` and `:350-353` cap
their maps at 500 and 200 with oldest-key eviction. Copy it (or drop in a tiny LRU helper and use
it everywhere).

### 2.4 Blocking log writes every 250 ms
`packages/server/src/services/logger.ts:141` — `fs.appendFileSync(file, payload)`, driven by a
250 ms interval, on the video server's event loop. With `DEBUG=1` and the per-segment logging in
`routes/plex.ts` this is a meaningful stall source.

**Fix.** `fs.createWriteStream(file, { flags: "a" })`, keep the batching, `.write()` the joined
payload. Keep the sync path only for the `uncaughtException` flush.

### 2.5 The orphan reaper polls Plex forever
`packages/server/src/routes/plex.ts:2146` — `setInterval(reapOrphanTranscodes, 60_000)`, running
`/transcode/sessions` every minute for the life of the process even when nothing has ever played.

**Fix.** `if (allKnownPlexKeys.size === 0) return;` at the top of `reapOrphanTranscodes`.

### 2.6 Search fires on a single character
`packages/client/src/components/Search.tsx:45` debounces 400 ms but has no minimum length. Each
call to `/api/plex/search` costs a Plex `/hubs/search`, a Discover cloud search, and up to 15
parallel `isGuidInLibrary` lookups (`routes/plex.ts:467`). Typing "the" issues three of those.

**Fix.** `if (q.trim().length < 2) { onClearRef.current(); return; }`.

### 2.7 `plexJSON`'s body read is untimed
`packages/server/src/services/plex.ts:34-43` clears the abort timer in `finally`, which fires as
soon as the response *headers* land. That's correct and deliberate for `plexFetchSegment` (you
don't want the timer killing a body stream), but it means `plexJSON`'s `res.json()` on line 79 has
no timeout: a Plex that accepts the connection and then stops sending hangs the request forever.

**Fix.** Give `plexJSON` its own `AbortSignal.timeout()` spanning the body read, or clear the timer
after `.json()`/`.text()` resolves.

### 2.8 Minor
- `sessionIdForPlexKey` (`routes/plex.ts:2079`) is an O(n) scan called inside `flushStaleTranscodes`'
  loop. Keep a reverse `plexKey → sessionId` map.
- `packages/client/src/lib/api.ts:43` — `posterThumbUrl` appends `w`/`h` even for external
  (Discover/TMDB) art, which the server validates and then ignores (`routes/plex.ts:1826`).
  Harmless, but two wasted params on every Discover poster.

---

## 3. Security

### 3.1 The guild allowlist can't actually keep anyone out
`packages/server/src/routes/discord.ts:250-255`

```js
if (ALLOWED_GUILD_IDS.size > 0) {
  if (!normalizedGuildId || !ALLOWED_GUILD_IDS.has(normalizedGuildId)) { 403 }
}
```

`guildId` comes from `req.body` and is never verified against Discord. Any user who can complete
the OAuth flow can `POST /api/register` with an allowed guild id in the body and be admitted. The
allowlist is a client-side convention, not a control.

The fix is already half-built: `useDiscord.ts:43` requests the `guilds` OAuth scope and never uses
it. In `POST /api/token`, alongside the existing `/users/@me` call, fetch
`GET /users/@me/guilds` with the access token, store the verified guild ids on the session, and
check *those* in `/register`.

### 3.2 Any authenticated user can evict another channel's watch party
`packages/server/src/routes/discord.ts:263-269`

```js
if (normalizedChannelId) {
  const existingInstanceId = channelInstances.get(normalizedChannelId);
  if (existingInstanceId && existingInstanceId !== instanceId && instanceHosts.has(existingInstanceId)) {
    deleteInstanceStmt.run(existingInstanceId);
    instanceHosts.delete(existingInstanceId);
    …
```

`channelId` is client-supplied and unverified. A user in one server can pass another server's
channel id and delete its registration outright — the running party's clients then fail their next
`join` with "Unknown instance" and surface the misleading "Session expired" banner (the exact
failure the comment on line 20 says this design was meant to *fix*).

**Fix.** Same verified-membership approach as 3.1; at minimum, only evict when the requester is the
current `hostUserId` of the instance being evicted, or when the instance is older than some grace
period.

### 3.3 Session tokens ride in query strings
`packages/client/src/lib/api.ts:21` (`authUrl`), used for every `<img src>` poster, every HLS
segment/ping URL, and the `sendBeacon` unload flush (`lib/log.ts:81`).

`requireAuth` accepts `?token=` deliberately and the server's own logger redacts it
(`services/logger.ts:58`) — but the VPS nginx relay, any reverse proxy, and the browser's own
history/referrer chain do not. A 24-hour session token in an access log is a 24-hour session.

**Options, cheapest first.** (a) Make sure the nginx relay config strips/does not log query
strings. (b) Issue a separate short-lived, read-only token scoped to `/thumb` + `/hls/seg`.
(c) Set the session as an `HttpOnly; SameSite=None; Secure` cookie for the media routes so
`<img>`/`<video>` authenticate without the URL.

### 3.4 `"play"` is the only sync message with no validation
`packages/server/src/services/sync.ts:562-590`

Every other handler in this file rebuilds its payload from scratch —
`sanitizeQueueItem` (277), the whitelisted rebuild in `"suggest"` (515-530), the
`/^\d+$/` check in `"play-item"` (631), the length cap on `"browse"` (684), `safePosition` (262).
`"play"` takes `msg.ratingKey`, `msg.title` and `msg.hlsSessionId` as raw casts, writes them into
room state, broadcasts them to every client, and hands `hlsSessionId` to `startRoomPing` →
`pingPlexTranscode` → a Plex query parameter.

It's host-only, so this isn't a privilege escalation — but it's the one gap in an otherwise
consistent defence, and an unbounded `title` is echoed to the whole room.

**Fix.** `NUMERIC_RE` on `ratingKey`, `UUID_RE` on `hlsSessionId`, a length cap on `title`.

### 3.5 A throw in the WebSocket message handler takes the process down
`packages/server/src/services/sync.ts:393-793`

The whole `ws.on("message", …)` body is unguarded past the `JSON.parse` try/catch. Anything that
throws inside it — a `ws.send` on a socket that closed between the `readyState` check
(`broadcast`, line 206) and the write, an unexpected shape reaching `logEvent` — escapes the
emitter as an `uncaughtException`, and `logger.ts:199-203` deliberately rethrows, so the process
exits. That kills every room on the server, not just the offending one.

**Fix.** Wrap the handler body in try/catch and log. Wrap `ws.send` in `broadcast`/`sendTo`/
`sendToAll` too.

### 3.6 `isAllowedExternalImage` accepts any HTTPS URL
`packages/server/src/routes/plex.ts:3230-3241`. Mitigated by design — `fetchExternalImage` routes
everything through `images.plex.tv`, so this server only ever connects to that one host, and the
code says so. Noting it only because the safety property lives in a *different* function than the
validator, so a future change to `fetchExternalImage` turns this into an open proxy with no local
signal. A comment cross-reference on the validator, or a host allowlist, would pin it.

### 3.7 Dependency advisories
`npm audit --omit=dev`: 12 findings, 4 high.

| package | via | severity |
|---|---|---|
| `ip` (SSRF in `isPublic`) | `bittorrent-tracker` → `p2p-media-loader-core` → `-hlsjs` | high |
| `elliptic` | `browserify-sign` → `crypto-browserify` → `vite-plugin-node-polyfills` | — |
| `uuid` (<11.1.1 bounds check) | `@discord/embedded-app-sdk` 1.9.0 | moderate |

The `p2p-media-loader` chain is the one that ships to browsers *and* runs the tracker in your
server process, so it's the one worth attention. `@discord/embedded-app-sdk` is on 1.9.0 with 2.x
released — that upgrade clears the `uuid` finding and is worth doing on its own merits.
The `package.json` `overrides` block is already doing this kind of surgical pinning well; these
three just aren't in it yet.

---

## 4. Correctness — smaller but real

### 4.1 `recoverMediaError` can loop forever
`packages/client/src/components/Player.tsx:1099-1103`

```js
if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
  hls.recoverMediaError();
  return;
}
```

No attempt counter — every other error class in this handler has one (`networkRetryRef`,
`retryCountRef`, `recoveryAttemptRef`). A persistently broken buffer recovers, fails, recovers,
forever, with a `logError` line each time. hls.js's own documented pattern is: first failure →
`recoverMediaError()`; second within a short window → `swapAudioCodec()` then
`recoverMediaError()`; third → give up and fall through to the teardown path below.

### 4.2 Refs read during render decide whether the retry button appears
`packages/client/src/components/Player.tsx:2415`

```jsx
{!recovering && !error && recoveryAttemptRef.current >= MAX_RECOVERY_ATTEMPTS && !sessionIdRef.current && (
```

Mutating a ref doesn't schedule a render, so whether the user ever sees "Stream lost / Retry"
depends on some unrelated state change happening to re-render afterwards. `setRecovering(false)` on
line 1203 does happen to trigger one in the current flow, which is why this mostly works — but it's
accidental. Promote both to state (or a single `playbackDead` boolean set in the exhausted branch).

### 4.3 `roomPingIntervals` can outlive its room
`packages/server/src/services/sync.ts`

`stopRoomPing` is called on explicit `"stop"` (650) and when a host is the last client out (850).
It is *not* called by the 5-minute room reaper (865-871), nor on the path where the last client to
leave isn't flagged host (855) — which is reachable, because the duplicate-connection eviction at
line 448 sets `existing.isHost = false`. The orphaned interval then pings Plex every 30 s for a room
that no longer exists.

**Fix.** Call `stopRoomPing(instanceId)` everywhere `rooms.delete(instanceId)` happens.

### 4.4 `req` shadowed inside an Express handler
`packages/server/src/routes/seerr.ts:163`

```js
for (const req of data.mediaInfo?.requests ?? []) {
```

Inside an `(req, res)` handler. Harmless today because the loop body doesn't reach for the outer
`req` — and exactly the kind of thing that becomes a real bug on the next edit. Rename to `request`.

### 4.5 Sessions expire hard at 24 h with no renewal
`packages/server/src/middleware/auth.ts:7, 92-116`

`getSession` checks `Date.now() - createdAt > SESSION_TTL_MS` and never refreshes `created_at`.
A long-running party (or a client that leaves the tab open overnight) hits a hard
"Session expired — please close and restart the activity" (`Player.tsx:2277`) mid-watch.

**Fix.** Slide the window: on a successful `getSession`, if the entry is older than, say, an hour,
bump `created_at` in both the cache and the DB.

Minor, same file: lines 44-50 re-prepare a `SELECT token, user_id, created_at FROM sessions`
inline when `selectAllStmt` (line 41) is exactly that statement.

### 4.6 `reconnectFailed` is a dead end
`packages/client/src/hooks/useSync.ts:455-459` gives up after 20 attempts and sets a flag the UI
renders as "Connection lost — please close and restart the activity", with no way back. A "Try
again" button that resets `retryRef.current = 0`, clears the flag and calls `connect()` saves a
full activity restart.

### 4.7 `suggestions` grows without bound
`packages/client/src/hooks/useSync.ts:401-406` appends every incoming suggestion with no cap. A
viewer spamming suggestions grows the host's array indefinitely. Cap at ~20 with oldest-out.

### 4.8 History is capped at 100 rows and says so misleadingly
`packages/client/src/components/Library.tsx:31, 168, 533`

`fetchHistory({ limit: HISTORY_PAGE_SIZE })` — no `offset` is ever sent, and there is no
"load more" for the History tab. But line 533 renders `${historyTotal} titles` from the server's
full count. So a user with 400 watched titles sees "400 titles" above a grid that stops at 100 with
no indication the rest exists. Either paginate (the API already supports `offset`) or show
"showing 100 of 400".

### 4.9 `express-rate-limit` v7 will log an IPv6 validation warning
`packages/server/src/index.ts:115`

```js
keyGenerator: (req) => req.ip || req.socket.remoteAddress || "unknown",
```

v7.5.1 validates custom key generators for IPv6 handling and emits `ERR_ERL_KEY_GEN_IPV6` at
startup. It also reimplements the library's default behaviour exactly. Delete the line.

### 4.10 Two unbounded maps in watch-history
`packages/server/src/services/watch-history.ts:423` (`lastWriteAt`) and `:599`
(`manyStmtCache`). Both grow slowly and both are the only maps in a file that otherwise evicts
carefully (318-321, 350-353). `lastWriteAt` is cleaned per-user on delete/clear but never for a
user who simply stops using the app.

### 4.11 Stale doc comment
`packages/server/src/routes/plex.ts:1526` documents `GET /api/plex/person/:tagId?name=<name>`;
the route registered on line 1542 is `GET /person` and reads only `?name=`.

---

## 5. UX / product improvements

**Rich Presence never updates.** `useDiscord.ts:90-96` sets `details: "Watch Together"`,
`state: "Browsing the library"` once at startup and never again. For an Activity whose whole
proposition is watching together, having Discord show the actual title while it plays is close to
free: call `sdk.commands.setActivity` on play, on item change, and on stop. (This needs the SDK
instance to be reachable outside `useDiscord` — return it, or move the call behind a small
`useDiscordPresence` hook fed from `syncState.title`.)

**Drop the unused OAuth scopes** — or use them. `guilds` and `rpc.voice.read`
(`useDiscord.ts:43`) are requested and never touched, which widens the consent screen users see for
no benefit. `guilds` is also the key to fixing §3.1, so the better move is to start using it.

**Room state is memory-only.** `rooms` in `sync.ts:117` is a plain `Map`. A container restart or
crash loses the queue, the position and the roster for every live party; sessions and instances are
persisted to SQLite but the room isn't. Given the queue is a curated list someone built by hand,
persisting `RoomState` alongside the instance row would be a real quality-of-life win.

**The health check is green when Plex is down.** `Dockerfile` HEALTHCHECK hits `/`, which
`express.static` + the SPA fallback serve from disk with no upstream involved. A
`/api/health` that pings `/library/sections` (cached ~30 s) would make the container status mean
something.

**Poster grids.** `MovieCard`/`PosterShelf` images could take `loading="lazy"` and
`decoding="async"`, and the 200-item page currently fires ~200 requests at once. Given `thumbLimiter`
exists specifically because that was locking users out, lazy loading treats the cause.

**First-run diagnostics.** Several features fail completely silently when unconfigured —
no `TMDB_API_KEY` means no collections/recommendations/person pages, no `MDBLIST_API_KEY` means no
ratings row, no `PLEX_ACCOUNT_TOKEN` means Discover detail 401s. A single startup line listing which
optional integrations are active would save a lot of "why is this row empty".

---

## Suggested order of work

1. §1.1 warmer auth, §1.3 prefetch leak, §1.2 terminate token — server correctness, all small diffs.
2. §1.4 + §1.5 CSP — one object literal, fixes broken icons and main-thread demuxing.
3. §2.1 thumb-cache indexing — the biggest single perf win.
4. §1.6 reconnect isHost, §1.7 touch controls — the two user-facing breakages.
5. §3.1 + §3.2 — verify guild/channel membership server-side using the scope you already request.
6. §2.3 cache eviction, §2.2 byte budgets, §2.4 async logging — long-run stability.
7. Everything in §4 as cleanup; §5 as a roadmap.
