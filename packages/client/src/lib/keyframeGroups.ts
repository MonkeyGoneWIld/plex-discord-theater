/**
 * A copy's segments that don't open on a keyframe.
 *
 * The bot cuts a copied segment longer than eight seconds into pieces of
 * about four (server: ffmpeg/split-segment.ts), named after it: 00012aa.m4s,
 * 00012ab.m4s, and so on. Only the first, "aa", opens on the keyframe. The
 * rest carry on from the piece before, and the browser drops a piece that
 * doesn't follow straight on from the last one appended, because it has
 * nothing to decode it from. Film 20578 has its keyframes 29 s apart at the
 * start. As one segment that was 97.6 MB, and the picture took 33 s to come.
 *
 * Where playback goes by keyframes (how far back the buffer can be cut, where
 * a skip lands), it goes by groups: a keyframe piece and the pieces after it
 * (keyframeGroups). Where it goes by what is fetched, it goes by the pieces,
 * and playing from inside one costs the pieces before it in its group too
 * (leadInBytes, nextNeeded). hls.js is kept from loading a piece on its own
 * (loadInstead, guardPieceLoads): left to it, a skip into the middle of a
 * group loaded the same two pieces over and over, two thousand times in
 * eight seconds, with nothing to show.
 */

/**
 * A piece's name, and the two letters after its segment's number: the last
 * part of its path, which a copy's URL carries encoded in its query
 * (/api/plex/hls/seg?p=%2F…%2Fbase%2F00012ab.m4s&n=…).
 */
const PIECE = /(?:\/|%2[Ff])b?\d+([a-z]{2})\.(?:ts|m4s)(?:[?#&]|$)/;

/** Whether a segment opens on a keyframe: anything but a piece after its group's first ("aa"). */
export function opensOnKeyframe(url: string | undefined): boolean {
  const m = url ? PIECE.exec(url) : null;
  return !m || m[1] === "aa";
}

export interface ListedSpan {
  start: number;
  duration: number;
  url?: string;
  gap?: boolean;
}

/**
 * The segments as keyframe groups: each piece folded into the keyframe piece
 * before it, the group named by that piece. The list itself when nothing in it
 * is a piece after a group's first.
 */
export function keyframeGroups<T extends ListedSpan>(segments: ReadonlyArray<T>): ReadonlyArray<T | ListedSpan>;
export function keyframeGroups<T extends ListedSpan>(segments: ReadonlyArray<T> | null | undefined): ReadonlyArray<T | ListedSpan> | null;
export function keyframeGroups<T extends ListedSpan>(segments: ReadonlyArray<T> | null | undefined): ReadonlyArray<T | ListedSpan> | null {
  if (!segments) return null;
  if (segments.every((s) => opensOnKeyframe(s.url))) return segments;
  const groups: ListedSpan[] = [];
  for (const s of segments) {
    const last = groups[groups.length - 1];
    if (last && !opensOnKeyframe(s.url)) {
      last.duration = s.start + s.duration - last.start;
      last.gap = last.gap || s.gap;
    } else {
      groups.push({ start: s.start, duration: s.duration, url: s.url, gap: s.gap });
    }
  }
  return groups;
}

/**
 * What has to come in before the picture can come from inside each segment,
 * besides the segment itself: the pieces before it in its group that aren't
 * `cached`, in bytes. 0 for one that opens on a keyframe. Null when a size
 * isn't known.
 */
export function leadInBytes(
  segments: ReadonlyArray<{ url?: string; bytes: number | null; cached?: boolean }>,
): Array<number | null> {
  const out: Array<number | null> = [];
  let sum: number | null = 0;
  for (let i = 0; i < segments.length; i++) {
    if (opensOnKeyframe(segments[i].url)) sum = 0;
    out.push(sum);
    const s = segments[i];
    if (sum !== null && !s.cached) sum = s.bytes !== null && s.bytes > 0 ? sum + s.bytes : null;
  }
  return out;
}

export interface LoadableFragment {
  sn: number | "initSegment";
  level: number;
  url: string;
}

/**
 * What to load when hls.js asks for `frag`: `frag` itself when it opens on a
 * keyframe, or follows straight on from `previous` (the last one hls.js
 * buffered, null after a seek or a stop). Otherwise the next piece of its group
 * after `previous`, when that is in the same group before it; and otherwise
 * the group's keyframe piece.
 */
export function loadInstead<F extends LoadableFragment>(frag: F, previous: F | null, fragments: ReadonlyArray<F>): F {
  if (typeof frag.sn !== "number" || opensOnKeyframe(frag.url) || !fragments.length) return frag;
  const sameLevel = previous !== null && previous.level === frag.level && typeof previous.sn === "number";
  if (sameLevel && previous!.sn === frag.sn - 1) return frag;
  const first = fragments[0].sn;
  if (typeof first !== "number") return frag;
  const at = frag.sn - first;
  if (fragments[at]?.sn !== frag.sn) return frag;
  let k = at;
  while (k > 0 && !opensOnKeyframe(fragments[k].url)) k--;
  if (!opensOnKeyframe(fragments[k].url)) return frag;
  if (sameLevel && (previous!.sn as number) >= (fragments[k].sn as number) && (previous!.sn as number) < frag.sn) {
    return fragments[(previous!.sn as number) - first + 1] ?? frag;
  }
  return fragments[k];
}

/** The parts of hls.js's stream controller guardPieceLoads reaches into. */
interface StreamController<F extends LoadableFragment> {
  fragPrevious?: F | null;
  fragmentTracker?: { removeFragment?: (frag: F) => void };
  loadFragment?: (frag: F, level: { details?: { fragments?: ReadonlyArray<F> } }, targetBufferTime: number) => void;
}

/**
 * hls.js made to load a group's pieces from its keyframe (loadInstead). It has
 * no setting for it: in 1.6 and 1.7 it takes every fMP4 segment to open on a
 * keyframe, and for MPEG-TS it goes back one segment at a time. The piece
 * loaded instead may be one it already holds, from before the skip, and is
 * loaded again all the same: the browser needs the keyframe appended first.
 * `onInstead` hears of each one. False when hls.js isn't as this expects, and
 * nothing is changed.
 */
export function guardPieceLoads<F extends LoadableFragment>(
  hls: unknown,
  onInstead?: (asked: F, instead: F) => void,
): boolean {
  const sc = (hls as { streamController?: StreamController<F> } | null)?.streamController;
  const load = sc?.loadFragment;
  if (!sc || typeof load !== "function" || !("fragPrevious" in sc)) return false;
  sc.loadFragment = function (this: StreamController<F>, frag, level, targetBufferTime) {
    const fragments = level?.details?.fragments;
    const instead = fragments ? loadInstead(frag, this.fragPrevious ?? null, fragments) : frag;
    if (instead !== frag) {
      this.fragmentTracker?.removeFragment?.(instead);
      onInstead?.(frag, instead);
    }
    return load.call(this, instead, level, targetBufferTime);
  };
  return true;
}
