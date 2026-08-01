# plex-discord-theater — audit

Four passes. The first (at `677288e`) found 40 issues; most were fixed in
`38a4653` / `94858fa`. The second (below, from "Round 2") re-verified those and
covered the rest. Round 3 is about the shared session specifically — several
people watching, co-hosts, seeking, changing host, changing subtitles,
simultaneous commands, and playback going backwards. **Round 4 is at the top**
and is the first pass driven by production logs rather than by reading.

Both packages typecheck clean and the production build succeeds.

---

## Round 4 — what the logs said

Round 3 was reasoning plus a synthetic harness. This pass is a day of real
traffic: the app's own log for 2026-08-01, and the Plex server's logs for the
same window. Several things that looked fine in the code were not happening at
all in production.

### Every keep-alive and every stop was refused by Plex

`GET /video/:/transcode/universal/ping?session=<our-uuid>` → **404**, 804 times
in one day. Every `stop` too, 27 for 27. Both confirmed from Plex's side:

```
DEBUG - Completed: [192.168.80.2] 404 GET /video/:/transcode/universal/ping?session=6840d858-…
DEBUG - Completed: [192.168.80.2] 404 GET /video/:/transcode/universal/stop?session=6840d858-…
```

Round 2 changed this call from Plex's transcode GUID to our session id and
recorded the reasoning at length. The parameter name was right; the identifier
still isn't the one Plex matches on. Nothing was keeping transcodes alive — the
`/:/timeline` posts were doing that by accident — and nothing was ever stopping
them, so abandoned encoders sat there until Plex timed them out.

Rather than swap one guess for another, `transcodeControl` now tries our id,
falls back to the mapped Plex key on a 404, remembers whichever answered, and
logs which. If it turns out to be the key, one line in the log says so.

### A scrubbing pair started thirteen transcodes in one minute

The worst thing in the logs, and it was still present after round 3. Over 2m40s
of two people scrubbing, the host's player started and destroyed a transcode
every few seconds. Eleven of them were killed before Plex had answered the
manifest request at all; the shortest lived **four milliseconds**. Across the
day: 60 sessions started, 35 reached the point of being registered. The other 25
were work Plex did and then threw away — and since `stop` doesn't reach them
(above), each left an encoder running.

The cause is one line in the HLS effect's cleanup:

```js
// Whatever happens next re-establishes this; leaving it set would make
// every later seek take the restart path.
restartPendingRef.current = false;
```

What comes next is *this effect re-running*, and cleanup fires first — so the
flag was cleared by the very commit that set it. `restartPending` was true for
about a millisecond in its entire life, which made the guard it exists for dead
code. Every seek arriving during a rebuild therefore measured itself against a
detached element reporting position 0, no buffer, and a session offset belonging
to a transcode that had never existed, concluded it needed a restart, and killed
the one still starting up. Visible in the log as `sessionStartOffsetS=5488.40`
repeating across seek after seek to positions nowhere near it.

Now: the flag is set when the effect starts a session and cleared where it stops
being true (manifest parsed, fatal error, or a 20s age bound), and a newer seek
target waits up to 5s for an in-flight restart to land instead of replacing it.
A burst costs two transcodes — the one already running and the one at the final
target — rather than a dozen.

The buffer-starvation warnings track this exactly: 114 across the day, clustered
in the same minutes as the restarts (04:32-04:34, 14:06-14:08, 03:41). That
stutter *was* this.

### The kill-everything endpoint was open

`DELETE /api/plex/hls/sessions` stops every transcode this app has running. It
was gated on `NODE_ENV !== "production" || matching ADMIN_SECRET` — and this
deployment does not set `NODE_ENV`, which its own logs prove: 6,734 `[HLS seg]
Fetching` lines that only exist under `DEBUG`. So the escape hatch was wide open
to any authenticated viewer: one request, every stream in every room dead.

Verified rather than argued — pre-fix build, no `NODE_ENV`, ordinary session
token, request from a non-loopback address:

```
PRE-FIX : HTTP 502   ← passed the gate, went on to call Plex
FIXED   : HTTP 403   ← refused, and logged
```

The gate is now positive: the request either comes from this machine or carries
`ADMIN_SECRET`. Nothing about it depends on an environment variable being set
correctly, because the deployment that forgets `NODE_ENV` is exactly the one
that shouldn't be trusted with it.

> `NODE_ENV=production` is still worth setting on that deployment — it also
> selects the production rate limits (600/15min instead of 5,000) and stops the
> per-segment logging. That is a deployment change, not a code one.

### Rich Presence has never worked

Round 2 added presence that follows what is playing. Every client, every
session: `setActivity failed: {"code":4006,"message":"Not authenticated or
invalid scope"}`. `setActivity` needs `rpc.activities.write`, and the scope list
is `["identify", "guilds"]` — the same round removed `rpc.voice.read` for being
unused and the remaining list never had the one this feature depends on. Discord
showed "Browsing the library" for whole sessions, two hours into a film, exactly
as before the feature was written.

The scope is now requested, with a fallback to the old list if `authorize`
refuses it — a broken launch would be a far worse outcome than a stale presence
line, and that fallback is what makes asking safe. Failures also latch now, so a
scope Discord won't grant produces one log line instead of one per title change.

> This may need the app re-authorized before it takes effect: the request uses
> `prompt: "none"`, so an existing grant without the new scope can fail and drop
> to the fallback. If presence still doesn't update, that's the reason.

### Smaller things the logs surfaced

| # | Item | Fix |
|---|---|---|
| 1 | **"TIMELINE STALLED" fired every 10s for a merely paused stream** — 82 in one hour, all `playing=0`, all saying only that somebody had pressed pause. A diagnostic that fires constantly during normal use is what a real stall hides inside | The check requires `playing`. The freeze clock also resets on resume, so the first ping after one no longer looks like a multi-minute stall and report `buffering` to Plex for a stream that just started again |
| 2 | `terminatePlexSession` returns **403 every time** (35 today) even though `PLEX_ACCOUNT_TOKEN` is configured — so the last-resort cleanup doesn't work either | Not changed: the body is a bare `<html>…403 Forbidden` page and Plex logged no `sessions/terminate` request in the window available, so this needs checking against the Plex account's own permissions rather than a code change. With `stop` fixed it should also matter far less |
| 3 | 19 × `getaddrinfo EAI_AGAIN api.themoviedb.org` | Container DNS, not ours. Noted so the next reader doesn't chase it |
| 4 | P2P delivered **17 MB against 3,994 MB over HTTP** in one two-viewer session | Expected and already documented (the high-demand window covers the whole buffer), but it is the number that makes the case for the VPS relay concrete |

---

## Round 3 — the shared session

Everything here was reproduced before it was fixed. A 44-check multi-client
WebSocket harness drives real sockets through join, roles, transport, handover,
teardown, hostile payloads and a message flood, asserting on what the server
actually broadcasts. **The pre-fix build fails 13 of the 44; the fixed build
passes all 44.** Each item below names the check that pins it.

### The room's position had two authorities

`pause` and `resume` wrote `msg.position` — the *sender's* playhead — into room
state, and room state is broadcast to everyone. For the host that is correct. For
a co-host it is not: their playhead trails the host's by whatever their buffer is
behind, and if their stream has stalled it can trail by minutes.

So a co-host pressing pause dragged every viewer back to wherever the co-host
happened to be, and the host's next heartbeat dragged them forward again. That is
the "it jumped back in time" report, with a yo-yo behind it. Reproduced: host
heartbeats at 1800s, co-host pauses reporting 42s, room broadcasts 42s.

Pause and resume are about *whether*, not *where*, so a non-host's number is now
discarded in favour of the room's own interpolated position. A **seek** still
keeps the sender's number — that one is a decision, not an observation.

> `a co-host's pause does not drag the room back to its own playhead` ·
> `a co-host's resume keeps the room position` · `a co-host's seek IS authoritative`

### A co-host lost their role every time their socket blinked

`isCoHost` lived only on the connection object, which dies with the socket. A
dropped WebSocket, a tab reload, Discord backgrounding the activity — any of them
brought the co-host back as a plain viewer with their controls silently gone and
nothing on screen saying why. Grants now live on the room, keyed by Discord user
id, so the role belongs to the person rather than to the connection. Handing over
the host role spends the grant rather than remembering it, so passing the role
back doesn't quietly restore a co-host badge nobody re-issued.

> `co-host role is restored on rejoin` · `reconnected co-host can still drive
> transport` · `handing the role back does not restore a stale co-host grant`

### Handing over the host role stranded the outgoing host on black

The player picked which HLS session to follow from a *mount-time* flag. That
stopped promotion tearing a working stream down, and missed the opposite
direction entirely: a host who hands the role over keeps that flag forever, so it
went on requesting segments from a session the new host had already replaced.
Those 410, the retry budget runs out, and the rebuild asks for
`owner ? newSession : viewerSession` — which for a demoted host is `null`. "No
session id yet, waiting for sync", permanently. The only way out was leaving the
activity and coming back.

It now latches on "the room has moved to a session we are not on", which says the
same thing about promotion (a host follows nothing) and is also true after a
handover: nothing happens at the moment of demotion, and when the new host does
restart, the ex-host follows like any other viewer.

### Joining a paused room played the film to one person alone

The manifest handler called `video.play()` unconditionally. If the room was
already paused, no command was coming — the pause had happened before the join —
and heartbeats deliberately don't drive transport, so nothing ever corrected it.
One person watched ahead while everyone else sat on a still, until a later pause
or seek pulled them back.

Two halves: the manifest handler holds instead of playing when the room it is
joining is paused, and a new effect keeps every non-host's element matching the
room's play state on any change, not just on explicit commands.

### A reconnecting host was corrected by its own stale echo

The room's copy of what is playing comes entirely from the host, so whatever the
server holds while the host's socket is down is whatever the host last managed to
send. On reconnect the snapshot is therefore stale *by construction* — and the
player applied it: a host that had paused during the outage was un-paused by its
own echo, and one that had played on was dragged back to its last check-in and
then broadcast that as the room's truth.

Snapshots are now distinguishable from commands (`stateSeq`). A host with a live
session ignores them and pushes the correction the other way instead —
re-announcing the session if the room lost track of it, then its real position
and play state.

### Drift correction was itself the stutter

There was one threshold: under 3s nothing happened, over it a seek fired. A seek
throws away the fragment hls.js has in flight and reloads from the target, so the
correction rebuffers — and a room settles just under the threshold and stays
permanently out of step. Several viewers hovering around 3s produced a visible
hitch each, every few seconds, for the whole film.

Now two tiers. Inside 4s, playback rate is nudged by at most 8% to close the gap —
inaudible, invisible, and it converges to under half a second instead of parking
at three. Outside 4s the old seek path takes over. Speeding up is refused when the
forward buffer is under 6s, because catching up is exactly what empties it. The
rate is reset on pause, on a hard seek, on promotion to host, and on every
pipeline rebuild.

### Everything else

| # | Item | Fix |
|---|---|---|
| 1 | **Nothing bounded WebSocket message rate.** A seek writes to SQLite and broadcasts to the room; a `queue-reorder` rebuilds and re-broadcasts up to 100 items. One authenticated client in a loop saturated both. Measured: 400 seeks sent, 400 relayed | 120 messages per 10s per connection, dropped past that, logged once per 10s. Real use is a heartbeat every 5s |
| 2 | **Forced history writes had no floor.** `pause`, `seek` and `stop` each bypass the history service's throttle, so a scrub burst was a SQLite write per message | 2s floor for command-driven forced writes; teardown paths still always write, so the final position is never lost |
| 3 | **A stop wiped the queue** — and the host never saw it, because the server excludes the sender from its own broadcast, so their panel still listed items the server had thrown away | The queue survives a stop. It is what to watch *next*; finishing the current thing is when it matters most |
| 4 | **A rejected queue item got no answer at all**, leaving an optimistic client showing an entry the server never accepted | Every queue mutation answers with the server's copy, to everyone including the sender |
| 5 | **Instances expired 24h after registration, live or not.** A party still running the next day had its registration pruned out from under it and every later join failed with "Unknown instance" | The TTL slides on join (one write per hour per instance), so it measures idleness rather than age |
| 6 | **Prefetch silently gave up past two sessions** — and the usual way to reach two is a seek-restart, whose outgoing session is still being torn down while the replacement asks for its manifest. So seeking while a second party watched dropped the seeker back to unbuffered Plex throttling, which is the exact case prefetch exists for | One global 384 MB budget shared across up to four sessions, and at capacity the *oldest* is displaced rather than the newcomer refused. Memory ceiling is now independent of the session count |
| 7 | **A joiner or promoted host assumed the transcode started at 0:00**, so every backward seek took the in-place path and sat out the full six-second stall before restarting | The session's start offset is part of room state, carried on `state` and `play`, and separate from the position (they differ when a host re-announces a session it has already played some of) |
| 8 | **Re-picking the subtitle track already playing restarted the transcode** — several seconds of rebuffering for the whole room, changing nothing. Easy to hit by reopening the switcher and tapping the ticked row, or by two co-hosts choosing the same track a moment apart (two restarts, back to back) | The current audio/subtitle stream is tracked, seeded from Plex's own answer, and claimed before the request so an in-flight duplicate is recognised too |
| 9 | **A dropped socket was completely silent** until all twenty automatic retries had failed — over a minute of pressing pause and browsing into a void that looked exactly like a quiet room | A "Reconnecting…" state in the player and while browsing, held back 2.5s so an ordinary blip shows nothing |
| 10 | **A co-host's own seek dropped their scrub bar to 0:00.** The host holds its bar at the target through a restart; viewers get the same via the seek broadcast; the co-host who *asked* was the one person watching it crawl back | Same hold, locally, when the target isn't already buffered |
| 11 | **A viewer's player item was a stub typed "movie" with no artwork or ancestry** — sync state carries a ratingKey and a title and nothing else. So for every viewer an episode wasn't an episode: it rendered as a bare episode name, and reaching the end left them on the episode instead of the show | `/meta` carries episode ancestry (it already had it), and the stub is replaced by the real item as soon as the lookup lands — without disturbing playback, since the ratingKey doesn't change |
| 12 | **`join` read `sessionToken` / `instanceId` / `userId` off the message with a cast.** A non-string that survived the truthiness check would have thrown inside the handler rather than been refused | Typed at the boundary |
| 13 | Reconnect churn: `username` was a dependency of the socket effect, so a change tore the socket down mid-party and rejoined | Read at join time from a ref |
| 14 | A heartbeat could self-heal a missing `ratingKey` but not a missing `hlsSessionId`, leaving a viewer with nothing to attach hls.js to | Both are healed |

### Verified against the pre-fix build

Not argued from reading the code. The same harness was run against the build from
before this pass, and it fails exactly the checks these fixes target:

```
FAIL  co-host role is restored on rejoin
FAIL  reconnected co-host can still drive transport
FAIL  a co-host's pause does not drag the room back to its own playhead
FAIL  a co-host's resume keeps the room position
FAIL  a co-host's seek IS authoritative
FAIL  the queue survives a stop
FAIL  a rejected queue item still gets an answer
FAIL  createdAt was pushed forward (was 23h old)
FAIL  a flood is throttled rather than relayed in full — {"delivered":400}
...
31/44 checks passed
```

The fixed build passes 44/44, and its log over the run contains no uncaught
exception — only the expected "Plex unreachable" errors from the test
environment, each caught at its call site.

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

> **The invite picker: two attempts, both reverted. Do not try a third.**
>
> The complaint is that Discord's invite dialog lists text channels and an
> "Invite to Server" section alongside people. Two things were tried:
>
> 1. **`shareLink` instead of `openInviteDialog`.** Broke the feature.
>    `openInviteDialog` creates an invite *to the channel*, so whoever accepts
>    lands in **this** activity instance — same room, in sync. `shareLink`
>    shares a *URL*, which launches the activity wherever it is opened, so the
>    invited friend ends up alone in a separate watch party. It also lists
>    channels itself, so it didn't even solve the cosmetic problem.
>
> 2. **A custom people-only panel**, built on SDK 2.x `getChannel` →
>    `voice_states` (the call roster) plus `inviteUserEmbedded`. It worked, but
>    the roster is empty whenever nobody else is in the voice channel — which is
>    the common case when you are inviting *because* nobody is there yet. It
>    replaced a working button with a panel that said "Nobody in the call to
>    invite" and then made you press a second button to get the real dialog.
>
> **The dialog's contents are not ours to change.** It is rendered by the
> Discord client, outside the activity's iframe. `openInviteDialog()` takes no
> arguments. There is no SDK command that both filters that list to people and
> preserves the activity instance. The only true people-only source is
> `getRelationships`, whose `relationships.read` scope is part of Discord's
> Social SDK and gated behind an approval application.
>
> Current state: the button calls `openInviteDialog` and nothing else. If the
> channel clutter must go, the route is an application to Discord for
> `relationships.read`, not another code change.

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
