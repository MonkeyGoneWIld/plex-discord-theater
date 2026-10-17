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
  return `Catching up with the room… ${Math.max(1, Math.ceil(leftS))} s`;
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
