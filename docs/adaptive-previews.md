# Adaptive scrub previews

The tooltip position, timestamp, and seek destination always follow the pointer.
Only the preview image changes density with movement speed:

- Fast movement (0.8 timeline widths/second): about 24 evenly spaced images,
  plus the last frame, with at least 180 ms between image selections.
- Medium movement is the default: about 96 images, plus the last frame,
  with at least 150 ms between selections.
- Precise inspection requires 500 ms of sustained movement no faster than both
  0.008 timeline widths/second and six original frames/second. Only then is every
  original BIF frame selectable, with no image-selection throttle. Full detail
  exits above 0.015 widths/second or ten original frames/second. Using the frame
  count prevents long videos from entering full detail at ordinary search speeds.
- A 650 ms pause restores full detail at the current position without requiring
  another pointer event. Speed hysteresis prevents switching levels repeatedly
  near a threshold. Leaving the timeline resets the motion history to medium.
  Moving again after a pause starts in medium and must qualify for full detail
  again; the time spent stationary does not count toward the movement dwell.

Once playback meets the existing buffer-headroom requirement, the client fetches
`/api/plex/preview/:partId/index?progressive=1`. A single response automatically
sends the overview, additional medium frames, and then all remaining frames.
Each JPEG is transferred once. Short videos can have empty later passes.
While a finer image is still arriving, a previously received coarser image is
used. A stationary hover improves as those finer frames arrive.

The server still reads the whole BIF from Plex in chronological order. It emits
overview images as it encounters them and spools the deferred images to a
temporary file. Thus this prioritizes **server-to-viewer** delivery; it does not
reduce Plex-to-server traffic or make the final overview frame arrive before
Plex supplies it. Deferred data stays off the server heap, and the temporary file
is removed on completion, failure, or disconnect. Stalled upstream reads time out
after 30 seconds. The existing 1 GiB overall bound is also enforced while reading.

The progressive response has content type `application/x-plex-preview-v1`. Its
little-endian format is a uint32 header length, the original BIF header and index
including the first JPEG marker, then `(uint32 frame index, uint32 byte length,
JPEG bytes)` records. Client and server use medium stride `ceil(count / 96)`
(minimum 1) and coarse stride `medium * 4`. The final frame belongs to the overview.
The original endpoint response is unchanged without the opt-in; newer clients
also accept the original BIF content type from older servers.

Server logs record `transfer started` with `transport=progressive-v1` (or
`legacy-bif`) and a `tier sent` event for each pass. Client logs record
`transfer accepted` and `tier ready` events as the JPEGs are parsed. Both tier
events include `tier`, the number of new `frames`, their record `bytes`, cumulative
`ready` frames, and elapsed milliseconds. Empty passes are recorded as zero.
Client events are emitted at record boundaries, so they remain correct even if
all three tiers arrive in one browser read. Server events mean data has been
queued for sending; client events confirm receipt. No artificial delay separates
the tiers, so a fast connection can complete all three almost immediately.

For a 3,214-frame BIF, the new-frame counts are **25 / 71 / 3,118** and cumulative
ready counts are **25 / 96 / 3,214**. The progressive protocol's initial header is
25,790 bytes. Older logs only recorded index arrival and overall completion,
which cannot establish individual tier completion times.

## Verification

`npm test` includes `packages/server/test/preview-stream.test.ts`, covering the
server-to-client protocol, stage ordering, no duplicate transfers, long videos,
short videos, partial records, malformed input, cancellation, URL disposal, and
movement-speed transitions, precision dwell, and long-video sensitivity. Server
and client tier counts are compared, including coalesced network reads and
rejection of a medium frame arriving before the overview. Existing BIF tests
cover legacy download behavior.

For a live Plex/Discord check, open a title with generated preview thumbnails:

1. Sweep the timeline quickly: images should remain readable while the timestamp
   tracks the pointer precisely.
2. Slow to a moderate sweep: the medium grid should remain stable. Move very
   slowly within a small area for at least half a second: full detail should appear.
3. Stop after a fast sweep: after 650 ms the preview should refine at the stopped
   position. Brief pauses while searching should not enable full detail.
4. Throttle the network and hover near the end: the overview should arrive before
   the full set, followed by finer images without further movement.
5. Change titles during the download and during a scrub: old frames and pending
   timers must not appear on the new title. Repeat with a touch drag and a title
   without generated previews.
