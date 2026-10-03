# Adaptive scrub previews

The tooltip position, timestamp, and seek destination always follow the pointer.
Only how often the preview picture may change adapts to how fast it moves.

## Speed tiers

Speed is how far the pointer got over the last 250 ms, in timeline widths per
second, so it behaves the same on a phone and a desktop.

| Tier | Speed | Picture changes at most every |
|---|---|---|
| still | below 0.02 | no limit |
| slow | 0.02 – 0.05 | 100 ms |
| moderate | 0.05 – 0.085 | 140 ms |
| fast | 0.085 – 0.17 | 170 ms |
| sweep | 0.17 and up | 200 ms |

Every tier shows the finest frame downloaded for the pointer's position. The
tiers never pick different frames, so a tier changing never changes the picture
under a pointer that isn't moving. Showing the same frame again does not restart
the gap.

- A hover starts at sweep.
- Speeding up switches tier at once. The 250 ms window still takes a moment to
  register a sudden speed-up.
- Slowing down while still moving steps one tier at a time, each once the speed
  has read slower for 300 ms: sweep to fast to moderate to slow.
- Holding still goes straight to still after 300 ms.
- A pointer that stops sends no more events, so a timer looks again whenever the
  window or a step next moves on, always at the latest position. After a sweep,
  the picture catches up once to where the pointer stopped.
- Leaving the timeline resets the motion history.

## Staged download

The frames arrive in four passes, each its own request to
`/api/plex/preview/:partId/index?progressive=2&pass=<0-3>`, made once the video
has buffered far enough past the playhead:

| Pass | Frames, cumulative | Requested once the buffer reaches |
|---|---|---|
| 0 coarse | 5% | immediately |
| 1 medium | 15% | 7 s |
| 2 fine | 40% | 15 s |
| 3 full | 100% | 30 s |

A pass also stops reading while the buffer is back under its mark, so a seek lets
the video refill first. A buffer that reaches the end of the video counts as
enough. Until a pass arrives, the nearest frame from an earlier one stands in.

Counts round up to whole frames, with a minimum of one. Each tier is an even
spread of the frames drawn from the next finer tier, so every tier contains the
ones before it, and each JPEG is sent once. For 3,214 original frames, new-frame
counts are **161 / 322 / 803 / 1,928** and cumulative ready counts are
**161 / 483 / 1,286 / 3,214**.

The server reads Plex's BIF in order. Asked for one pass, it sends the head and
then that pass's images as it comes to them, and stops reading after the last of
them; nothing is spooled. Asked without a pass, it sends all four in one
response, spooling deferred images to a temporary file that is removed on
completion, failure, or disconnect. Upstream reads time out after 30 seconds, and
the 1 GiB overall bound is enforced as read.

## Wire format

The content type is `application/x-plex-preview-v2`. The little-endian framing is
a uint32 header length, the original BIF header and index plus the first JPEG
marker, then records of `(uint32 frame number, uint32 byte length, JPEG bytes)`.

Each pass's response repeats the head. The client checks that it matches the
first and carries on with the same reader, which expects each tier's records in
order. A pass cut off inside a record ends the chain, and the frames already
received stay usable.

Explicit v1 requests keep their old fixed-size grids, with an empty fine pass,
and their content type. A server without passes sends everything in the first
response, which the client takes as complete, and an ordinary BIF from an older
server is still read. Client and server layout helpers live in their respective
build roots; regression tests compare their outputs.

Before the index arrives, or for a part Plex has no index for, the player asks
Plex for single frames at its two-second interval instead.

## Diagnostics and verification

Server logs record `transfer started` with the transport and pass, and
`tier sent` for each pass. Client logs record `transfer accepted`,
`frame index ready`, `pass requested` with the buffer it was requested at,
`tier ready` as complete JPEGs are parsed, and `frames complete` or
`frames incomplete`. `speed tier selected` records each change of speed tier.

`npm test` includes:

- `packages/client/test/scrub-preview-motion.test.ts`: the speed bands on
  desktop and phone widths, starting at sweep, step-down timing, going straight
  to still when the pointer stops, and pointer jitter.
- `packages/server/test/preview-stream.test.ts`: exact percentage counts,
  nesting, ordering, no duplicates, long and short videos, partial and coalesced
  records, one pass per response, mismatched heads, malformed input,
  cancellation, URL disposal, and v1 compatibility.
- `packages/client/test/preview-frames.test.ts`: BIF parsing.

For a live Plex/Discord check:

1. Start a title and watch the client log: `pass requested` should appear as the
   buffer passes 7, 15 and 30 seconds.
2. Hover the timeline and hold still: once the picture appears it should not
   change, except while passes are still arriving.
3. Sweep quickly, then stop: the picture catches up once, then holds.
4. Seek while a pass is downloading: it should wait until the buffer refills.
5. Change titles mid-download and mid-scrub; old frames and timers must not
   appear. Repeat with a touch drag and a title without generated thumbnails.
