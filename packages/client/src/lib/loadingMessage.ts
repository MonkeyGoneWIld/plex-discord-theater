/**
 * What the loading screen says.
 *
 * Never only "Loading...". Somebody looking at a spinner wants to know whether
 * anything is happening and what is being waited for — the host, Plex, the
 * server, or their own connection — and a spinner that says nothing for half
 * a minute reads as broken whether it is or not.
 */

export interface LoadingFacts {
  /**
   * Where the stream is: Plex hasn't answered with a playlist yet; the
   * playlist is in but nothing has played; or it played and has stopped.
   */
  phase: "starting" | "first-frames" | "stalled";
  /** The host's name, when this player is holding for the host's picture. */
  waitingForHost: string | null;
  /** How long the screen has been up, seconds. */
  forS: number;
  /** What is arriving, kbps, over the last few seconds; null if unmeasured. */
  downloadKbps: number | null;
  /** What the stream needs, kbps, when the server said. */
  streamKbps: number | null;
  /** Downloads have been failing in the last few seconds. */
  failing: boolean;
  /** Plex is copying the file rather than re-encoding it. */
  copied: boolean;
}

/** How long before the screen says more than what it is doing. */
const SAY_MORE_AFTER_S = 4;

const mbps = (kbps: number) => `${(kbps / 1000).toFixed(kbps >= 10_000 ? 0 : 1)} Mbps`;

export function loadingMessage(f: LoadingFacts): { title: string; detail: string | null } {
  if (f.waitingForHost) {
    return {
      title: `Waiting for ${f.waitingForHost}…`,
      detail: f.forS >= SAY_MORE_AFTER_S ? "Everyone starts together once their video is ready" : null,
    };
  }
  const late = f.forS >= SAY_MORE_AFTER_S;
  const slow = f.downloadKbps !== null && f.streamKbps !== null && f.downloadKbps < f.streamKbps * 0.95;
  const speed = f.downloadKbps !== null && f.downloadKbps >= 100 ? `Downloading at ${mbps(f.downloadKbps)}` : null;

  if (f.phase === "starting") {
    return {
      title: "Starting the stream…",
      detail: !late ? null : f.forS >= 15
        ? "Plex is taking longer than usual to start this one"
        : f.copied ? "Plex is reading the file" : "Plex is preparing the video",
    };
  }
  if (f.failing) {
    return { title: f.phase === "stalled" ? "Buffering…" : "Loading the video…", detail: "Having trouble reaching the server — retrying" };
  }
  if (f.phase === "first-frames") {
    return {
      title: "Loading the video…",
      detail: !late ? null : slow
        ? `Your connection is bringing in ${mbps(f.downloadKbps!)}; this video needs about ${mbps(f.streamKbps!)}`
        : speed ?? "Waiting for the server to send the first part",
    };
  }
  return {
    title: "Buffering…",
    detail: !late ? null : slow
      ? `Your connection is bringing in ${mbps(f.downloadKbps!)}; this video needs about ${mbps(f.streamKbps!)}`
      : speed ?? "Waiting for the server",
  };
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
