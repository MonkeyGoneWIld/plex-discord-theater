/**
 * What the loading screen says: "Loading…" until this stream's picture has
 * moved, "Buffering…" once it has and has stopped. Nothing more — download
 * speeds and who is being waited for were noise to somebody who only wants to
 * know the film is on its way.
 */
export function loadingTitle(pictureShown: boolean): string {
  return pictureShown ? "Buffering…" : "Loading…";
}

/**
 * What it says instead while this player waits ahead of the room for it to
 * get there (lib/roomWait), with the seconds left — which the room's clock
 * says exactly. "Buffering…" for that wait read as the player's own trouble,
 * with no end: on 17 October a viewer sat twenty seconds on it, not knowing
 * what was happening.
 */
export function catchingUpTitle(leftS: number): string {
  return `Catching up to host · ${Math.max(1, Math.ceil(leftS))} s`;
}

/**
 * How much of a backfill is in, 0 to 1 — the room paused while this player
 * waited ahead of it, and it is fetching what it jumped over, `fromS` to
 * `toS`, backwards (Player's backfill): `reachedS` is how far back what is in
 * goes, and `partS` the film in hand of the segment coming.
 */
export function backfillShare(fill: { fromS: number; toS: number; reachedS: number; partS: number }): number {
  const span = fill.toS - fill.fromS;
  if (!(span > 0)) return 1;
  return Math.min(1, Math.max(0, (fill.toS - fill.reachedS + fill.partS) / span));
}

/**
 * What the loading screen says meanwhile. A share, not seconds: when it is
 * done depends on the download, which no clock says — a countdown of it ran
 * out and started again (18 October). Never 100% while it is still there.
 */
export function backfillTitle(share: number): string {
  return `Host paused · Catching up to host · ${Math.min(99, Math.floor(share * 100))}%`;
}

/**
 * What has been arriving, kbps, from the downloads recorded as [when (ms),
 * bytes] — over the last `windowMs`, or null with nothing in it. Old entries
 * are dropped from `samples` as it goes.
 */
export function arrivingKbps(samples: Array<[number, number]>, nowMs: number, windowMs = 8_000): number | null {
  while (samples.length && nowMs - samples[0][0] > windowMs) samples.shift();
  if (samples.length === 0) return null;
  const bytes = samples.reduce((n, [, b]) => n + b, 0);
  return Math.round((bytes * 8) / windowMs);
}
