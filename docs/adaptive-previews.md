# Adaptive scrub previews

The tooltip position, timestamp, and seek destination always follow the pointer.
Only the preview image changes density with movement speed:

- Fast movement (0.8 timeline widths/second): about 24 evenly spaced images,
  plus the last frame, with at least 180 ms between image selections.
- Medium movement (0.12 widths/second): about 96 images, plus the last frame,
  with at least 100 ms between selections.
- Slow movement: every original BIF frame, with no image-selection throttle.
- A 240 ms pause restores full detail at the current position without requiring
  another pointer event. Speed hysteresis prevents switching levels repeatedly
  near a threshold. Leaving the timeline resets the motion history.

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

## Verification

`npm test` includes `packages/server/test/preview-stream.test.ts`, covering the
server-to-client protocol, stage ordering, no duplicate transfers, long videos,
short videos, partial records, malformed input, cancellation, URL disposal, and
movement-speed transitions. Existing BIF tests cover legacy download behavior.

For a live Plex/Discord check, open a title with generated preview thumbnails:

1. Sweep the timeline quickly: images should remain readable while the timestamp
   tracks the pointer precisely.
2. Slow to a moderate sweep, then move very slowly: image density should increase.
3. Stop after a fast sweep: the preview should refine at the stopped position.
4. Throttle the network and hover near the end: the overview should arrive before
   the full set, followed by finer images without further movement.
5. Change titles during the download and during a scrub: old frames and pending
   timers must not appear on the new title. Repeat with a touch drag and a title
   without generated previews.
