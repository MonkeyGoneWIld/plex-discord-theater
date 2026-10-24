/**
 * Where a fragmented-MP4 segment's video starts and ends — ts-timestamps.ts
 * for the segments the ffmpeg engine writes as fMP4 (AV1, and Opus or FLAC
 * copied as they are), read from its boxes.
 *
 * An fMP4 segment says nothing of its tracks: which is the picture and what
 * its clock ticks at are in the init segment (init.mp4), read once per run.
 * Each segment's moof then has, per track, where its first sample is decoded
 * (tfdt) and every sample's length and composition offset (trun), which is all
 * that is needed for where its picture starts and ends.
 *
 * hls.js lines an fMP4 stream up differently from a TS one: by the decode time
 * (tfdt) of whichever track starts first, not by presentation times — see its
 * passthrough-remuxer. `alignStart` is that, for the playlist to list each
 * segment where hls.js will put it.
 */
import type { VideoSpan } from "./ts-timestamps.js";

export interface Mp4Track {
  id: number;
  kind: "video" | "audio";
  timescale: number;
  /** trex's: what a fragment that doesn't say uses. */
  defaultDuration: number;
  defaultSize: number;
}

export interface Mp4Span extends VideoSpan {
  /** The earliest decode time of any track's first sample, seconds: where hls.js lines the segment up. */
  alignStart: number;
}

const u32 = (b: Uint8Array, at: number) => ((b[at] << 24) >>> 0) + (b[at + 1] << 16) + (b[at + 2] << 8) + b[at + 3];
const i32 = (b: Uint8Array, at: number) => (b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3];
const u64 = (b: Uint8Array, at: number) => u32(b, at) * 2 ** 32 + u32(b, at + 4);

interface Box {
  type: string;
  /** Where its body starts and where it ends. */
  start: number;
  end: number;
  /** Where the box itself starts. */
  at: number;
}

/** The boxes directly inside b[from, to). */
function boxes(b: Uint8Array, from: number, to: number): Box[] {
  const out: Box[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(b, at);
    let head = 8;
    if (size === 1) {
      if (at + 16 > to) break;
      size = u64(b, at + 8);
      head = 16;
    } else if (size === 0) {
      size = to - at;
    }
    if (size < head || at + size > to) break;
    out.push({ type: String.fromCharCode(b[at + 4], b[at + 5], b[at + 6], b[at + 7]), start: at + head, end: at + size, at });
    at += size;
  }
  return out;
}

const child = (b: Uint8Array, box: Box | undefined, type: string) =>
  box ? boxes(b, box.start, box.end).find((x) => x.type === type) : undefined;

/** The tracks of an init segment, or null when it has none it can read. */
export function initTracks(b: Uint8Array): Mp4Track[] | null {
  const moov = boxes(b, 0, b.length).find((x) => x.type === "moov");
  if (!moov) return null;
  const inMoov = boxes(b, moov.start, moov.end);
  const trex = new Map<number, { duration: number; size: number }>();
  const mvex = inMoov.find((x) => x.type === "mvex");
  for (const t of mvex ? boxes(b, mvex.start, mvex.end) : []) {
    if (t.type !== "trex" || t.end - t.start < 24) continue;
    trex.set(u32(b, t.start + 4), { duration: u32(b, t.start + 12), size: u32(b, t.start + 16) });
  }
  const tracks: Mp4Track[] = [];
  for (const trak of inMoov.filter((x) => x.type === "trak")) {
    const tkhd = child(b, trak, "tkhd");
    const mdia = child(b, trak, "mdia");
    const mdhd = child(b, mdia, "mdhd");
    const hdlr = child(b, mdia, "hdlr");
    if (!tkhd || !mdhd || !hdlr) continue;
    const id = b[tkhd.start] === 1 ? u32(b, tkhd.start + 20) : u32(b, tkhd.start + 12);
    const timescale = b[mdhd.start] === 1 ? u32(b, mdhd.start + 20) : u32(b, mdhd.start + 12);
    const handler = String.fromCharCode(b[hdlr.start + 8], b[hdlr.start + 9], b[hdlr.start + 10], b[hdlr.start + 11]);
    if ((handler !== "vide" && handler !== "soun") || !timescale) continue;
    const defaults = trex.get(id);
    tracks.push({
      id, kind: handler === "vide" ? "video" : "audio", timescale,
      defaultDuration: defaults?.duration ?? 0, defaultSize: defaults?.size ?? 0,
    });
  }
  return tracks.length ? tracks : null;
}

/**
 * The span of video in one fMP4 segment, on its own clock in seconds, or null
 * when it has none: where its picture starts (its earliest presentation time)
 * and ends (its latest plus that frame's length), where its sound starts, and
 * where hls.js lines it up (alignStart).
 */
export function mp4Span(tracks: readonly Mp4Track[], b: Uint8Array): Mp4Span | null {
  const byId = new Map(tracks.map((t) => [t.id, t]));
  let videoStart = Infinity;
  let videoEnd = -Infinity;
  let frames = 0;
  let audioStart = Infinity;
  let alignStart = Infinity;
  for (const moof of boxes(b, 0, b.length).filter((x) => x.type === "moof")) {
    for (const traf of boxes(b, moof.start, moof.end).filter((x) => x.type === "traf")) {
      const inTraf = boxes(b, traf.start, traf.end);
      const tfhd = inTraf.find((x) => x.type === "tfhd");
      const tfdt = inTraf.find((x) => x.type === "tfdt");
      if (!tfhd || !tfdt) continue;
      const track = byId.get(u32(b, tfhd.start + 4));
      if (!track) continue;
      const flags = u32(b, tfhd.start) & 0xffffff;
      let at = tfhd.start + 8;
      if (flags & 0x1) at += 8; // base data offset
      if (flags & 0x2) at += 4; // sample description index
      let defaultDuration = track.defaultDuration;
      if (flags & 0x8) {
        defaultDuration = u32(b, at);
        at += 4;
      }
      let dts = b[tfdt.start] === 1 ? u64(b, tfdt.start + 4) : u32(b, tfdt.start + 4);
      alignStart = Math.min(alignStart, dts / track.timescale);
      for (const trun of inTraf.filter((x) => x.type === "trun")) {
        const version = b[trun.start];
        const tf = u32(b, trun.start) & 0xffffff;
        const count = u32(b, trun.start + 4);
        let p = trun.start + 8;
        if (tf & 0x1) p += 4; // data offset
        if (tf & 0x4) p += 4; // first sample's flags
        for (let i = 0; i < count && p <= trun.end; i++) {
          let duration = defaultDuration;
          let cts = 0;
          if (tf & 0x100) {
            duration = u32(b, p);
            p += 4;
          }
          if (tf & 0x200) p += 4;
          if (tf & 0x400) p += 4;
          if (tf & 0x800) {
            cts = version === 1 ? i32(b, p) : u32(b, p);
            p += 4;
          }
          const pts = (dts + cts) / track.timescale;
          if (track.kind === "video") {
            videoStart = Math.min(videoStart, pts);
            videoEnd = Math.max(videoEnd, pts + duration / track.timescale);
            frames++;
          } else {
            audioStart = Math.min(audioStart, pts);
          }
          dts += duration;
        }
      }
    }
  }
  if (!frames) return null;
  return {
    start: videoStart,
    end: videoEnd,
    frames,
    audioStart: Number.isFinite(audioStart) ? audioStart : null,
    alignStart,
  };
}
