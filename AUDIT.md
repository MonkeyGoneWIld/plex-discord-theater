# plex-discord-theater — audit

Two passes. The first (at `677288e`) found 40 issues; most were fixed in
`38a4653` / `94858fa`. This document is the **second pass**: it re-verifies those
fixes, records what the fixes themselves introduced, and covers the remaining
items plus the end-user improvements applied on top.

Both packages typecheck clean and the production build succeeds. The server was
smoke-tested (boot, health, auth, and hostile WebSocket payloads) against a
running instance.

---

## Round 2 — what this pass changed

### A. Regressions introduced by the round-1 fixes

**A1. The loopback rate-limit exemption was spoofable.** `index.ts`
`isLoopback()` read `req.ip`, and its comment claimed "not spoofable: this is
the socket's peer address, not a header". With `app.set("trust proxy", 1)` that
is exactly backwards — `req.ip` is *derived from* `X-Forwarded-For`. A directly
exposed deployment could be handed `X-Forwarded-For: 127.0.0.1` and skip the API
rate limiter entirely. Now reads `req.socket.remoteAddress` only, which is the
kernel's answer.

**A2. The cache warmer broke again after 24 hours.** The new warmer session was
minted once per process, but sessions expire at `SESSION_TTL_MS` (24h) and the
process outlives that — so the warmer worked for one day and then silently 401'd
forever, the same failure it had just been fixed for, arriving a day late. It
now re-mints on a 401 and retries once.

**A3. A malformed `play` wiped room state.** The new validation resolved a bad
`ratingKey`/`hlsSessionId` to `null` and then *applied* it — which is
indistinguishable from a stop: it cleared what everyone was watching and
broadcast a "play" with nothing to play. Malformed messages are now dropped and
logged, leaving the room untouched.

**A4. `InviteButton` could set state after unmount.** Discord's dialog outlives
the component when the people panel is closed while it's open. Guarded, and the
note timer is cleared on unmount.

### B. A remote crash, found and fixed this pass

`sync.ts` read `msg.type` straight off `JSON.parse(raw)`. `JSON.parse("null")`
returns `null`, so reading `.type` threw a `TypeError` — and `ws` emits
synchronously, so it escaped as an `uncaughtException`, which `logger.ts`
deliberately rethrows. **Any authenticated client could end the entire server,
and every watch party running on it, by sending the four characters `null`.**

Verified empirically rather than by reading: built the pre-fix server, sent
`null` from an authenticated socket, and the process died mid-request —

```
=== is the PRE-FIX server still alive? ===
http_code=000
NO RESPONSE — process died
```

The fixed build takes `null`, `5`, `"x"`, `[]`, `{"type":null}` and malformed
JSON in a row and keeps serving. Three layers now: the parse result is checked
for object-ness, `type` is coerced defensively, and the whole handler runs inside
a `try/catch` so no future edit can reintroduce the class.

### C. Remaining round-1 items, now fixed

| # | Item | Fix |
|---|---|---|
| C1 | Nine unbounded caches in `routes/plex.ts`, plus `ratings.ts` and `watch-history.ts` | New `services/lru.ts`; every cache is now an `LruMap` with an explicit cap |
| C2 | Prefetch bounded by segment *count*, not bytes | 192 MB budget per session; count cap kept as a secondary bound |
| C3 | `appendFileSync` per log flush (open+write+close, 4×/sec, forever) | Held append descriptor, single `writeSync`. Kept synchronous deliberately — shutdown and the crash handler write and then exit, and a queued stream write would be lost |
| C4 | `plexJSON` body read had no timeout | `withBodyTimeout` — a Plex that accepts and then stalls no longer hangs the request forever |
| C5 | Guild allowlist unenforceable | Verified server-side (below) |
| C6 | `channelId` eviction DoS | Verified server-side (below) |
| C7 | Unbounded `recoverMediaError` loop | 3 attempts, escalating to `swapAudioCodec()`, then falls through to the rebuild path. Budget resets after a clean minute |
| C8 | "Stream lost" panel gated on refs read during render | Promoted to `playbackDead` state |
| C9 | 24h hard session expiry | Sliding renewal, one write per hour per session |
| C10 | `reconnectFailed` was terminal | `retryConnection()` + a Reconnect button, in the player *and* while browsing |
| C11 | Unbounded `suggestions` | Capped at 20, deduped by `ratingKey` |
| C12 | History capped at 100 with the full count displayed above it | Real pagination with a Load More |
| C13 | `req` shadowed in a route handler (`seerr.ts`) | Renamed |
| C14 | Stale `/person/:tagId` doc comment | Corrected |

**C5/C6 — the guild allowlist is now a control rather than a convention.**
`/register` took `guildId` and `channelId` from the request body and never
checked either. Any authenticated user could name an allowed guild to get in, or
name another server's channel to delete its registration and strand a running
party on "Unknown instance". The `guilds` OAuth scope was already being requested
and never read — that is now what it's for: `/token` calls
`/users/@me/guilds`, stores the verified ids on the session (new `guild_ids`
column, idempotent migration in the existing style), and `/register` checks the
claim against them. Eviction additionally requires the requester to be a verified
member of the *existing* registration's guild.

Deliberately strict: an unverifiable session is refused rather than waved
through, because "lenient on lookup failure" is bypassable by anyone willing to
trigger their own rate limit. To keep that from locking out legitimate users, the
lookup retries once on a 429, honouring `Retry-After`.

### D. End-user improvements

**D1. The initial download is 61% smaller.** hls.js, p2p-media-loader,
bittorrent-tracker and the Node polyfills are the bulk of this app's JavaScript
and none of it is needed until someone actually watches something — but it all
had to arrive and parse before the library could paint, which is the first thing
anyone sees.

| | before | after |
|---|---:|---:|
| initial chunk | 1,247 kB (371 kB gzip) | **484 kB (144 kB gzip)** |
| player chunk | — | 763 kB (226 kB gzip), fetched on idle |

The player chunk is preloaded during the first idle moment after launch, so
pressing play still doesn't wait for it.

**D2. Rich Presence follows what is playing.** It was set once at startup and
never again, so Discord showed "Browsing the library" for the whole session
including two hours into a film. It now tracks room state — the same title for
every participant, which is what makes it read as a shared session in the member
list. Length-capped, since Discord rejects the whole payload over 128 chars.

**D3. The health check reflects reality.** `HEALTHCHECK` hit `/`, which
`express.static` answers off disk — the container stayed green through a total
Plex outage. New `/api/health` probes Plex (result cached 20s so a 30s probe
can't become a 30s Plex request), and the Dockerfile points at it.

**D4. Disconnection is visible while browsing.** The player has always said so;
outside it there was nothing, so a dropped socket looked exactly like a quiet
room — you could browse, pick something, and only then find out nobody saw any of
it. Now an amber banner with a Reconnect button.

**D5. Startup says which integrations are live.** Every optional integration
fails silently when unconfigured, and each has been mistaken for a bug:

```
[Config] · TMDB (no collections / recommendations / person pages)   · Ratings (ratings row hidden)
         · Requests (Seerr request flow off)   · Discover (online search detail may 401)
         · VPS relay (P2P mode)   · Guild allowlist (open to any Discord server)
```

**D6. One less thing on the consent screen.** `rpc.voice.read` was requested at
launch and never read by anything. Dropped; `identify` and `guilds` remain, and
`guilds` now does real work.

---

## Verified as fixed from round 1

Re-checked against the current tree, not taken on trust:

- Cache warmer now authenticates (`Authorization: Bearer`) — plus A2 above.
- `terminatePlexSession` passes `PLEX_ACCOUNT_TOKEN` through a new `plexFetch`
  token parameter; the comment that described this for a long time without it
  being true is now accurate.
- `DELETE /hls/session/:id` calls `markTranscodeStopped()` — the prefetch poller,
  transcode head and host-ping entries are all released.
- CSP: `data:` for images (the five inlined ratings icons), `blob:` for
  `media-src` and a new `worker-src` (hls.js's MSE attach and transmux worker).
- `useSync` derives `isHost` from the roster, so a client promoted while its
  socket was down learns about it on reconnect.
- Touch reveals the controls instead of toggling playback, with a consuming
  `consumeRevealTap()` so the same tap doesn't do both.
- `logs.ts` clamps invalid dates and strips newlines.
- History tab has `visible` in its deps.
- `docker-compose.yml` forwards the previously dropped variables.
- `thumb-cache.ts` keeps a running byte total behind an index on `cached_at` and
  sweeps on a timer — no more two full scans of a 500 MB BLOB table per write.
- Orphan reaper no longer polls Plex when nothing has played.
- Search requires two characters.
- The `hlsLimiter` custom `keyGenerator` is gone.

---

## Known and deliberately not changed

**Session tokens in query strings.** `authUrl()` puts the token on every
`<img>`, segment, ping and beacon URL because those contexts cannot set a
header. The server's own log redacts it; a reverse proxy's does not. Fixing this
properly means either a separate short-lived media token or a cookie for the
media routes — a real change to the auth model, and one worth doing deliberately
rather than folding into an audit pass.

**Poster images load eagerly.** `MovieCard` carries an explicit comment
explaining the choice ("load every poster up front so nothing pops in as the
user scrolls the non-virtualized rows and grids"). The cost — ~200 concurrent
requests on a library page — is already absorbed by `thumbLimiter` and the
server-side cache, which is now much faster. Left as the author intended.

**Room state is memory-only.** A restart loses the queue, position and roster
for every live party. Persisting `RoomState` alongside the instance row would fix
it, but it touches the core sync path and cannot be verified without a live
Discord Activity to test against.

**Dependency advisories.** 12 outstanding, 4 high — `ip` (SSRF) via
`bittorrent-tracker` → `p2p-media-loader`, `elliptic` via
`vite-plugin-node-polyfills`, and `uuid` via `@discord/embedded-app-sdk` 1.9.0.
All require major-version bumps of direct dependencies; the SDK upgrade to 2.x is
the one worth doing on its own merits and needs its own testing pass.

**`isAllowedExternalImage` accepts any HTTPS URL.** Safe as written, because
`fetchExternalImage` routes everything through `images.plex.tv`. Noted only
because the safety property lives in a different function than the validator.
