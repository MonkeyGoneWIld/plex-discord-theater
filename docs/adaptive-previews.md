# Adaptive scrub previews

The tooltip position, timestamp, and seek destination always follow the pointer.
Only the preview image changes density with movement speed and focus.

- Fast movement (0.8 timeline widths/second) uses 2% of the original frames,
  with at least 180 ms between image selections. The existing coarse-speed
  hysteresis retains this level down to 0.55 widths/second.
- Medium is the default and uses 15% of the original frames, with at least
  150 ms between selections.
- Full detail offers every original frame. It activates after 500 ms of slow
  movement (20 screen pixels/second or less), or after spending 650 ms within
  12 pixels of a focus anchor. A stationary pointer qualifies automatically.
- While inspecting, movement up to 40 pixels/second retains full detail.
  Leaving the focus area at normal search speed returns to medium; fast sweeps
  return to coarse. Leaving the timeline resets the motion history.

Slow speed is averaged over 150 ms to tolerate pixel quantization. It is based
on the rendered timeline width, not the number of frames in a video. Small
movements preserve the focus deadline rather than postponing it repeatedly.
The focus timer selects the latest pointer position and reschedules if it fires
early. This makes full detail reachable on long videos and during minor jitter.

## Three automatic transfer passes

After playback meets the existing buffer-headroom requirement, the client fetches
`/api/plex/preview/:partId/index?progressive=2`. One response automatically sends:

1. `ceil(total * 0.02)` overview frames.
2. Additional frames to reach `ceil(total * 0.15)` in total.
3. All remaining frames to reach 100%.

Counts round up to whole frames, with a minimum of one. Medium frames are evenly
spread across the timeline; the overview is an evenly distributed subset of that
grid. Each JPEG is transferred once. Tiny videos may have empty later passes.
For 3,214 original frames, new-frame counts are **65 / 418 / 2,731** and cumulative
ready counts are **65 / 483 / 3,214**. Downloading more frames never automatically
changes the selected hover-detail level. Missing fine previews fall back to
received coarser frames, and a stationary focused hover improves as data arrives.

The server reads Plex's BIF chronologically, emits overview images as encountered,
and spools deferred images to a temporary file for the later passes. This
prioritizes server-to-viewer delivery; it does not reduce Plex-to-server traffic.
The temporary file is removed on completion, failure, or disconnect. Upstream
reads time out after 30 seconds and the 1 GiB overall bound is enforced as read.
No artificial pause separates tiers, so fast connections can finish quickly.

The content type is `application/x-plex-preview-v2`. The little-endian framing is
a uint32 header length, original BIF header/index plus first JPEG marker, then
records of `(uint32 frame number, uint32 byte length, JPEG bytes)`. Version 2
changes the tier layout, not the framing. Explicit v1 requests retain their old
fixed-size grids and content type, so cached clients still work during upgrades.
New clients understand both versions and ordinary BIF responses from old servers.
Client and server layout helpers are kept in their respective build roots;
regression tests compare their outputs and end-to-end counts.

## Diagnostics and verification

Server logs record `transfer started` with the transport version and `tier sent`
for each pass. Client logs record `transfer accepted` and `tier ready` as complete
JPEGs are parsed. Tier events include the number of new `frames`, record `bytes`,
cumulative `ready` frames, and elapsed milliseconds. Empty passes are logged as
zero. Client boundaries are reported even when a proxy combines all tiers into
one read. `detail selected` logs separately record actual hover-detail transitions
and how many original frames are available.

`npm test` includes `packages/server/test/preview-stream.test.ts`. It covers exact
percentage counts, nesting, stage ordering, no duplicates, long and short videos,
partial and coalesced records, malformed input, cancellation, URL disposal, v1
compatibility, screen widths, slow movement, one-pixel motion, focus jitter,
early timers, stationary hovers, and fast reversals. Existing BIF tests cover
legacy file parsing. Production builds and client type checking also apply.

For a live Plex/Discord check:

1. Sweep quickly and then normally: the overview and medium grids should be stable.
2. Move slowly within a small area for half a second, or hold within a 12-pixel
   area for 650 ms: full detail should become available despite minor jitter.
3. Move by adjacent original-frame intervals while focused: the preview should
   use the original frames rather than remain on the medium grid.
4. On a throttled connection, inspect `tier ready` counts and `detail selected`
   independently. For 3,214 frames, verify cumulative counts 65, 483, and 3,214.
5. Change titles mid-download and mid-scrub; old frames and timers must not appear.
   Repeat with a touch drag and a title without generated thumbnails.
