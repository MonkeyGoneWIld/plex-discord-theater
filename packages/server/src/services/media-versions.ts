/**
 * Choosing between the files Plex holds for one title.
 *
 * Kept out of the route for the same reason the season-gap rule is: it is a
 * policy, not a piece of rendering, and it is the kind of policy that is easy to
 * get subtly wrong in a way no one notices until a film won't play.
 */

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
 * Two rules:
 *
 * A 4K file is dropped whenever the same title also exists at a lower
 * resolution. Every stream this app serves is transcoded down to 1080p, so
 * picking the 4K copy buys a viewer nothing at all and costs the server a 4K
 * decode for each one watching — which on most hardware is the difference
 * between a watch party and a slideshow. When 4K is the *only* copy it is
 * offered as normal: transcoding it is still much better than not playing the
 * film.
 *
 * What survives is ordered best first, so index 0 is the default. Plex's own
 * order is by when the file was added, which has nothing to do with which one
 * anyone wants.
 */
export function playableVersionOrder(media: VersionSource[]): number[] {
  if (media.length === 0) return [];
  const indexed = media.map((m, index) => ({ m, index }));
  const anyUhd = indexed.some(({ m }) => isUhd(m));
  const anyOther = indexed.some(({ m }) => !isUhd(m));
  const playable = anyUhd && anyOther ? indexed.filter(({ m }) => !isUhd(m)) : indexed;

  return playable
    .sort(
      (a, b) =>
        frameWidth(b.m) - frameWidth(a.m) ||
        (b.m.bitrate ?? 0) - (a.m.bitrate ?? 0) ||
        // Last resort: Plex's own order, so the result is stable rather than
        // dependent on the sort implementation.
        a.index - b.index,
    )
    .map(({ index }) => index);
}
