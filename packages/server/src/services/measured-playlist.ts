/**
 * The playlist for a stream laid out from what its segments actually hold.
 *
 * Shared by the two places that build one: Plex's copied streams
 * (direct-stream.ts) and the ffmpeg engine's (ffmpeg/engine.ts). Both measure
 * every segment's timestamps and hand the player an EVENT playlist in film
 * time — a gap up to where the stream starts, each segment at its true length,
 * and where to begin — so currentTime means the same thing whoever made the
 * stream. direct-stream.ts's module comment has the why of each part.
 */

export interface MeasuredSegment {
  /** How clients name it. */
  path: string;
  /** Film time, seconds: the earlier of where its audio and its video start. */
  start: number;
  /** Where its video ends, film time. */
  end: number;
  /** Where its picture starts, and its sound (null with none), film time. */
  videoStart: number;
  audioStart: number | null;
  /** Its size: part of its URL, which mustn't change between reloads. */
  bytes: number;
  /** The init segment it needs, as fragmented MP4: null or absent for MPEG-TS. */
  init?: { path: string; bytes: number } | null;
}

/**
 * How long each gap entry before a mid-film start is.
 *
 * Long, because hls.js walks them: until the element has jumped to the start
 * position it reads 0:00, and hls.js fills from there, one gap entry at a time,
 * a few milliseconds each. At 10s a session started an hour and a half in had
 * 540 of them.
 *
 * They are left out of the target duration, which hls.js doesn't hold an entry
 * to. It does time reloads by it: the first load of a playlist happens with
 * nothing buffered, so hls.js measures the player as being at 0:00, far from
 * the end, and waits a whole target duration to reload. With the gap entries
 * counted that was a minute, and a session started mid-film played the half
 * minute its first playlist listed and then sat waiting for the rest.
 */
export const FILLER_STEP_S = 60;

export const round3 = (n: number) => Math.round(n * 1000) / 1000;

/**
 * The playlist text for `segments`, of which the first `published` are listed:
 * the newest is left out until the next one says where it ends, unless the
 * stream has ended. `targetDuration` is the one handed out last time; the
 * returned one is never lower, since a target that shrank between reloads
 * would be a different playlist as far as the spec goes.
 */
export function measuredPlaylist(o: {
  segments: readonly MeasuredSegment[];
  published: number;
  /** Where the stream was asked to start, film time. */
  offsetS: number;
  ended: boolean;
  targetDuration: number;
  urlFor: (path: string, bytes: number) => string;
}): { text: string; targetDuration: number } {
  const list = o.segments.slice(0, o.published);
  const first = list[0] ?? o.segments[0];
  const lines: string[] = [];
  // Fragmented MP4: each segment's init segment, named before the first that
  // needs it — the gaps included — and again wherever it changes (what a run
  // started mid-film made of the stretch before it has its own).
  const fmp4 = !!first?.init;
  let mapped: string | null = null;
  const map = (init: MeasuredSegment["init"]) => {
    if (!init || init.path === mapped) return;
    mapped = init.path;
    lines.push(`#EXT-X-MAP:URI="${o.urlFor(init.path, init.bytes)}"`);
  };
  map(first?.init);

  // Up to the first segment: gaps, in steps the target duration can cover.
  const fillTo = first ? round3(Math.max(0, first.start)) : 0;
  let filled = 0;
  while (fillTo - filled > 0.0005) {
    const step = round3(Math.min(FILLER_STEP_S, fillTo - filled));
    lines.push(`#EXTINF:${step.toFixed(3)},`, "#EXT-X-GAP", fmp4 ? "gap.m4s" : "gap.ts");
    filled = round3(filled + step);
  }

  // Each segment runs to where the next one starts, so the running total is
  // exactly the timestamps — the last one, once the end is known, to its own end.
  let longest = 0;
  for (let i = 0; i < list.length; i++) {
    const seg = list[i];
    const next = o.segments[i + 1];
    const duration = round3((next ? round3(next.start) : round3(seg.end)) - round3(seg.start));
    longest = Math.max(longest, duration);
    map(seg.init);
    lines.push(`#EXTINF:${duration.toFixed(3)},`, o.urlFor(seg.path, seg.bytes));
  }
  const targetDuration = Math.max(o.targetDuration, Math.ceil(longest));

  const head = [
    "#EXTM3U",
    // EXT-X-MAP in a playlist that isn't I-frames only is version 6's.
    fmp4 ? "#EXT-X-VERSION:7" : "#EXT-X-VERSION:3",
    "#EXT-X-PLAYLIST-TYPE:EVENT",
    `#EXT-X-TARGETDURATION:${targetDuration}`,
    "#EXT-X-MEDIA-SEQUENCE:0",
  ];
  // Always, from the start of the title too: a playlist still growing is live
  // to hls.js, which would otherwise begin near the end of what is listed. Never
  // before both picture and sound have begun.
  const playable = first
    ? Math.max(first.videoStart, first.audioStart ?? first.videoStart)
    : fillTo;
  head.push(`#EXT-X-START:TIME-OFFSET=${round3(Math.max(o.offsetS, playable)).toFixed(3)},PRECISE=YES`);
  const tail = o.ended ? ["#EXT-X-ENDLIST"] : [];
  return { text: [...head, ...lines, ...tail].join("\n") + "\n", targetDuration };
}
