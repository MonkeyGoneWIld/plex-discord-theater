/**
 * Choosing between the files Plex holds for one title.
 *
 * Kept out of the route for the same reason the season-gap rule is: it is a
 * policy, not a piece of rendering, and it is the kind of policy that is easy to
 * get subtly wrong in a way no one notices until a film won't play.
 */

import { sourceMatchedKbps } from "./ffmpeg/plan.js";

/** The parts of a Plex Media entry this rule looks at. */
export interface VersionSource {
  /** Plex's own bucket: "4k", "1080", "720", "480", "sd". */
  videoResolution?: string;
  width?: number;
  height?: number;
  /** kbps — the tie-break between two files of the same resolution. */
  bitrate?: number;
}

/** Frame width each of Plex's resolution labels stands for. */
const RESOLUTION_WIDTHS: Record<string, number> = {
  "4k": 3840,
  "2160": 3840,
  "2160p": 3840,
  "1080": 1920,
  "1080p": 1920,
  "720": 1280,
  "720p": 1280,
  "576": 1024,
  "576p": 1024,
  "480": 854,
  "480p": 854,
  sd: 720,
};

/**
 * How wide the picture is, in pixels — the one number every comparison here
 * uses.
 *
 * Width rather than height, deliberately. A 2.39:1 UHD master is 3840×1600, and
 * 1600 is *less* than 1080p's 1080 — so a height test calls the 4K file the
 * lower-quality one and picks it as the default, which is the exact opposite of
 * what this rule is for. Width is constant across aspect ratios: scope, flat and
 * 16:9 releases of the same resolution are all 3840 (or all 1920).
 *
 * Returns 0 when Plex has told us nothing usable, which sorts last and counts as
 * not-4K — both the safe direction, since the cost of being wrong is offering a
 * file rather than hiding one.
 */
export function frameWidth(media: VersionSource): number {
  if (typeof media.width === "number" && media.width > 0) return media.width;
  const known = RESOLUTION_WIDTHS[(media.videoResolution ?? "").trim().toLowerCase()];
  if (known) return known;
  if (typeof media.height === "number" && media.height > 0) {
    return Math.round((media.height * 16) / 9);
  }
  return 0;
}

/**
 * Width at which a file counts as 4K.
 *
 * Below true UHD (3840) and DCI 4K (4096), and well above 1080p (1920), so
 * neither an unusual master nor a slightly-cropped one lands on the wrong side.
 */
export const UHD_MIN_WIDTH = 3000;

export function isUhd(media: VersionSource): boolean {
  return frameWidth(media) >= UHD_MIN_WIDTH;
}

/** "4K", "1080p", "720p", "SD" — how a version reads in the picker. Plex's own
 *  label wins when it has one, so the app agrees with what Plex shows. */
export function resolutionLabel(media: VersionSource): string {
  const r = (media.videoResolution ?? "").trim().toLowerCase();
  if (r === "4k") return "4K";
  if (r === "sd") return "SD";
  if (/^\d+$/.test(r)) return `${r}p`;
  if (r) return r.toUpperCase();
  const w = frameWidth(media);
  if (w >= UHD_MIN_WIDTH) return "4K";
  if (w >= 1800) return "1080p";
  if (w >= 1200) return "720p";
  if (w >= 900) return "576p";
  if (w > 0) return "SD";
  return "Unknown";
}

/**
 * The largest picture a transcode of this file may come out at, as Plex's
 * `videoResolution` takes it: the file's own size, for a player that decodes
 * pictures above 1080p smoothly (PlayerCaps.uhd), and nothing is ever made
 * larger, since the box only grows.
 *
 * For a player that doesn't, "1920x1080" unless the file is only just bigger:
 * a flat 1920x1080 shrank every file a few rows over it. A 1920x1088 encode —
 * common for x265, which pads to a multiple of 16 — came out at 1906x1080,
 * every pixel resampled to lose eight rows. So a file up to 2K DCI wide (2048)
 * and 16:10 tall (1200) is let through at its own size.
 */
/**
 * The ceilings a viewer may put on their own stream ("Quality" in the player),
 * kbps. Choosing one gives that viewer a stream of their own at no more than
 * it — a copy when the file fits, a re-encode at it when it doesn't — for a
 * connection that can't keep up with what everyone else is watching.
 */
export const QUALITY_LEVELS_KBPS = [20000, 12000, 10000, 8000, 4000];

/** A quality ceiling from a request or a message: one of the levels, else 0 —
 *  no ceiling. */
export function qualityKbps(v: unknown): number {
  const n = Number(v);
  return QUALITY_LEVELS_KBPS.includes(n) ? n : 0;
}

export function transcodeFrame(media: { width?: number | null; height?: number | null }, uhd = true): string {
  const w = media.width ?? 0;
  const h = media.height ?? 0;
  if (w > 0 && h > 0 && (uhd || (w <= 2048 && h <= 1200))) {
    return `${Math.max(1920, w)}x${Math.max(1080, h)}`;
  }
  return uhd ? "3840x2160" : "1920x1080";
}

/**
 * What Plex is asked to re-encode a version at: `askedKbps`, the server's
 * transcode bitrate or the viewer's ceiling, but no more than the file's own
 * picture needs in the codec it is made in (`outCodec`) at the size it comes
 * out within `frame` — as the ffmpeg engine has it (ffmpeg/plan.ts
 * sourceMatchedKbps).
 *
 * On the Plex engine every re-encode was made at the full bitrate. In Part H on
 * 4 November that was 20 Mbps, for Rain Man's 8.9 Mbps Dolby Vision on a screen
 * in SDR as for everything else, where the ffmpeg engine makes it at about 14.
 * The picture stopped for want of data nine times on those streams, in a
 * stream's first minute and mid-film, over connections that carried 8 to
 * 12 Mbps.
 */
export function plexReencodeKbps(
  askedKbps: number,
  version: { width?: number | null; height?: number | null; bitrate?: number | null; videoCodec?: string | null } | null,
  frame: string,
  outCodec: "h264" | "hevc",
): number {
  const [boxW, boxH] = frame.split("x").map(Number);
  const w = version?.width ?? 0;
  const h = version?.height ?? 0;
  // Plex shrinks a picture into the frame, keeping its shape, and never enlarges one.
  const fit = w > 0 && h > 0 ? Math.min(1, boxW / w, boxH / h) : 1;
  const outW = w > 0 ? Math.round(w * fit) : boxW;
  const outH = h > 0 ? Math.round(h * fit) : boxH;
  return sourceMatchedKbps({
    askedKbps,
    sourceKbps: version?.bitrate ?? null,
    sourceCodec: version?.videoCodec ?? null,
    outCodec,
    sourcePixels: w * h,
    outPixels: outW * outH,
    outHeight: outH,
  });
}

/** A video stream as Plex describes it, the parts that say what its picture is. */
export interface PictureSource {
  codec?: string;
  /** "main 10", "high". */
  profile?: string;
  bitDepth?: number;
  /** "smpte2084" is HDR10's PQ, "arib-std-b67" HLG, anything else SDR. */
  colorTrc?: string;
  DOVIPresent?: boolean;
  DOVIProfile?: number;
  /** 1 alongside HDR10, 4 alongside HLG, 0 nothing a player without Dolby
   *  Vision can show right — profile 5. */
  DOVIBLCompatID?: number;
  frameRate?: number;
  /** "progressive" or "interlaced". */
  scanType?: string;
  width?: number;
  height?: number;
}

/** What a file's picture is, for Stats for nerds: its dynamic range, and the
 *  rest worth knowing when the colours or the motion look wrong. */
export interface PictureFacts {
  /** "HDR10", "HLG", "Dolby Vision P8.1 / HDR10", "Dolby Vision P5"; null SDR. */
  hdr: string | null;
  /** "HEVC Main 10 · 10-bit · HDR10 · 3840×2160 · 23.976 fps". */
  text: string;
}

/** A video stream's PictureFacts; null without one. */
export function pictureFacts(stream: PictureSource | undefined, media: { width?: number; height?: number } = {}): PictureFacts | null {
  if (!stream) return null;
  const trc = stream.colorTrc?.toLowerCase();
  const base = trc === "smpte2084" ? "HDR10" : trc === "arib-std-b67" ? "HLG" : null;
  const dovi = stream.DOVIPresent || (stream.DOVIProfile ?? 0) > 0;
  const hdr = dovi
    ? `Dolby Vision${stream.DOVIProfile ? ` P${stream.DOVIProfile}${stream.DOVIBLCompatID ? `.${stream.DOVIBLCompatID}` : ""}` : ""}${base ? ` / ${base}` : ""}`
    : base;
  const codec = stream.codec?.toLowerCase();
  const codecText = codec === "h264" ? "H.264" : codec === "mpeg2video" ? "MPEG-2" : codec?.toUpperCase();
  const profile = stream.profile?.replace(/\b\w/g, (c) => c.toUpperCase());
  const w = stream.width ?? media.width;
  const h = stream.height ?? media.height;
  const text = [
    [codecText, profile].filter(Boolean).join(" ") || null,
    stream.bitDepth ? `${stream.bitDepth}-bit` : null,
    hdr ?? "SDR",
    w && h ? `${w}×${h}` : null,
    stream.frameRate ? `${Number(stream.frameRate.toFixed(3))} fps` : null,
    stream.scanType?.toLowerCase() === "interlaced" ? "interlaced" : null,
  ].filter(Boolean).join(" · ");
  return { hdr, text };
}

/** Cuts and editions a release names in its file name, and what to call each. */
const EDITION_WORDS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\bimax[ ._-]enhanced\b/i, "IMAX Enhanced"],
  [/\bimax\b/i, "IMAX"],
  [/\bdirector'?s[ ._-]cut\b/i, "Director's Cut"],
  [/\bfinal[ ._-]cut\b/i, "Final Cut"],
  [/\bextended\b/i, "Extended"],
  [/\btheatrical\b/i, "Theatrical"],
  [/\bunrated\b/i, "Unrated"],
  [/\buncut\b/i, "Uncut"],
  [/\bultimate[ ._-](?:cut|edition)\b/i, "Ultimate"],
  [/\bspecial[ ._-]edition\b/i, "Special Edition"],
  [/\banniversary[ ._-]edition\b/i, "Anniversary Edition"],
  [/\bopen[ ._-]matte\b/i, "Open Matte"],
  [/\bredux\b/i, "Redux"],
  [/\bcriterion\b/i, "Criterion"],
  [/\bremastered\b/i, "Remastered"],
];

/**
 * A file's edition, from its name: Plex's own {edition-…} tag, as Project
 * Hail Mary's two 4K files have ("1.43 IMAX", "IMAX"), else the cuts a
 * release names after the year or episode number — IMAX, Extended, Director's
 * Cut and the like. Null for none. Two copies of a film are told apart by it
 * more than by anything else about them.
 */
export function editionOf(file: string | null | undefined): string | null {
  if (!file) return null;
  const name = file.split(/[\\/]/).pop()!.replace(/\.[^.]+$/, "");
  const tagged = /\{edition-([^}]+)\}/i.exec(name)?.[1]?.trim();
  if (tagged) return tagged;
  // Past the year, or an episode's number, so a title's own words aren't taken.
  const after = /(?:^|[\s._(\[-])(?:(?:19|20)\d{2}|S\d{1,2}E\d{1,3})(?=$|[\s._)\]-])/i.exec(name);
  const rest = after ? name.slice(after.index + after[0].length) : name;
  const found = EDITION_WORDS.filter(([word]) => word.test(rest)).map(([, label]) => label);
  const named = found.filter((label) => !(label === "IMAX" && found.includes("IMAX Enhanced")));
  return named.length ? named.slice(0, 2).join(" ") : null;
}

/** "5.1", "7.1", "Stereo", "Mono" — channel counts as people say them. */
export function channelLabel(channels: number | undefined | null): string | null {
  if (!channels || channels < 1) return null;
  if (channels === 1) return "Mono";
  if (channels === 2) return "Stereo";
  return `${channels - 1}.1`;
}

/**
 * Which of a title's files to offer, and in what order.
 *
 * Returns positions in the array it was given, because that position is what
 * the Plex transcode decision takes as `mediaIndex` — so it has to survive both
 * the filtering and the reordering below.
 *
 * Every file is offered, best first, so index 0 is the default — with one
 * exception to "best": a 4K file goes after every lower-resolution copy of the
 * same title. Not for its picture, which a player that decodes 4K is sent as
 * it is, but for what it costs: a 4K file carries several times the bits,
 * mostly more than DIRECT_STREAM_MAX_KBPS, so it is re-encoded at 4K, four
 * times the work of 1080p, and each viewer downloads more. Picked on the
 * title page, it plays at 4K. When 4K is the only copy it is the default.
 *
 * Plex's own order is by when the file was added, which has nothing to do with
 * which one anyone wants.
 */
export function playableVersionOrder(media: VersionSource[]): number[] {
  if (media.length === 0) return [];
  const indexed = media.map((m, index) => ({ m, index }));
  const anyOther = indexed.some(({ m }) => !isUhd(m));
  /** 1 for a 4K file with a lower copy beside it: those go last. */
  const behind = (m: VersionSource) => (anyOther && isUhd(m) ? 1 : 0);

  return indexed
    .sort(
      (a, b) =>
        behind(a.m) - behind(b.m) ||
        frameWidth(b.m) - frameWidth(a.m) ||
        (b.m.bitrate ?? 0) - (a.m.bitrate ?? 0) ||
        // Last resort: Plex's own order, so the result is stable rather than
        // dependent on the sort implementation.
        a.index - b.index,
    )
    .map(({ index }) => index);
}
