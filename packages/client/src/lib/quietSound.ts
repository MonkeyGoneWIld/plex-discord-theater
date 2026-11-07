/**
 * A viewer's speed nudge (softSync) made only while the film's sound is
 * quiet. At any speed but 1 the browser either stretches the sound to keep
 * its pitch, heard as static, or lets the pitch move with the speed, heard as
 * everything sounding wrong: both were heard on 7 November. In a quiet
 * stretch there is nothing to hear either way. The nudge waits for one, plays
 * at its speed while it lasts, and goes back to 1 the moment sound comes.
 *
 * The sound is heard as audioBoost hears it: from a capture of the element
 * (captureStream), which leaves the element's own output and its timing
 * alone, and is taken before its volume, so muting doesn't make it quiet.
 * Where it can't be heard (no capture, no running audio context, a capture
 * that brings nothing) it is never quiet, and a gap is left to the seek that
 * takes over past softSync's band.
 */
import { logEvent } from "./log";

/** Below this level (RMS of full scale, -40 dBFS), the sound is quiet. */
export const QUIET_RMS = 0.01;
/** Quiet this long before a nudge plays: not the pause between two words. */
export const QUIET_FOR_MS = 300;
/** How often the sound is looked at while a nudge is wanted. */
const LOOK_MS = 50;

/**
 * The level of a capture's samples, RMS of full scale; null for nothing but
 * zeros, which is a capture not yet or no longer bringing anything as much as
 * silence, and is never taken for quiet.
 */
export function levelOf(samples: Float32Array): number | null {
  let sum = 0;
  let any = false;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    if (x !== 0) any = true;
    sum += x * x;
  }
  return any ? Math.sqrt(sum / samples.length) : null;
}

/** Whether the sound has been quiet for QUIET_FOR_MS, level by level. */
export class QuietClock {
  private since: number | null = null;
  hear(level: number | null, nowMs: number): boolean {
    if (level === null || level >= QUIET_RMS) {
      this.since = null;
      return false;
    }
    if (this.since === null) this.since = nowMs;
    return nowMs - this.since >= QUIET_FOR_MS;
  }
}

interface Ear {
  stream: MediaStream;
  track: MediaStreamTrack | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode;
  samples: Float32Array<ArrayBuffer>;
  clock: QuietClock;
}

let ctx: AudioContext | null = null;
let unavailable = false;
let toldStopped = false;
const ears = new WeakMap<HTMLMediaElement, Ear>();

function cantHear(why: string): null {
  if (!unavailable) logEvent("Sync", "the sound can't be heard here: no speed nudges, a gap is left to the seek", { why });
  unavailable = true;
  return null;
}

function earOf(video: HTMLMediaElement): Ear | null {
  if (unavailable) return null;
  const had = ears.get(video);
  if (had) return had;
  const capture = (video as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream;
  if (typeof capture !== "function") return cantHear("no captureStream");
  try {
    if (!ctx) {
      const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return cantHear("no Web Audio");
      ctx = new Ctor();
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    const ear: Ear = {
      stream: capture.call(video), track: null, source: null, analyser,
      samples: new Float32Array(analyser.fftSize), clock: new QuietClock(),
    };
    ears.set(video, ear);
    return ear;
  } catch (e) {
    return cantHear(String(e));
  }
}

/** The capture's newest sound track, as audioBoost follows it: each stream the element loads adds one. */
function follow(ear: Ear): void {
  for (const t of ear.stream.getVideoTracks()) if (t.readyState === "live") t.stop();
  const tracks = ear.stream.getAudioTracks().filter((t) => t.readyState === "live");
  const newest = tracks[tracks.length - 1] ?? null;
  for (const t of tracks) if (t !== newest) t.stop();
  if (newest === ear.track || !ctx) return;
  try { ear.source?.disconnect(); } catch { /* already gone */ }
  ear.source = null;
  ear.track = newest;
  ear.clock = new QuietClock();
  if (!newest) return;
  try {
    ear.source = ctx.createMediaStreamSource(new MediaStream([newest]));
    ear.source.connect(ear.analyser);
  } catch (e) {
    cantHear(String(e));
  }
}

/** Whether `video`'s sound has been quiet for QUIET_FOR_MS. */
function quietNow(video: HTMLMediaElement): boolean {
  const ear = earOf(video);
  if (!ear || !ctx) return false;
  if (ctx.state !== "running") {
    if (!toldStopped) logEvent("Sync", "the audio context that hears the sound isn't running: nudges wait for it", { state: ctx.state });
    toldStopped = true;
    void ctx.resume().catch(() => {});
    return false;
  }
  follow(ear);
  if (!ear.source) return false;
  ear.analyser.getFloatTimeDomainData(ear.samples);
  return ear.clock.hear(levelOf(ear.samples), performance.now());
}

interface Nudge {
  rate: number;
  timer: ReturnType<typeof setInterval>;
  wantedAt: number;
  playedMs: number;
}
const nudges = new Map<HTMLMediaElement, Nudge>();

/** The speed a nudge wants, playing or waiting for quiet; 1 for none. */
export function wantedRate(video: HTMLMediaElement): number {
  return nudges.get(video)?.rate ?? 1;
}

/** Play `video` at `rate` whenever its sound is quiet, until dropNudge. */
export function wantNudge(video: HTMLMediaElement, rate: number): void {
  const had = nudges.get(video);
  if (had) {
    had.rate = rate;
    return;
  }
  const nudge: Nudge = { rate, wantedAt: performance.now(), playedMs: 0, timer: setInterval(() => {
    const quiet = quietNow(video);
    if (quiet) nudge.playedMs += LOOK_MS;
    const now = quiet ? nudge.rate : 1;
    // Played as it is, not stretched: what is left of a sound starting is
    // the least changed by it.
    if (quiet && video.preservesPitch !== false) video.preservesPitch = false;
    if (video.playbackRate !== now) video.playbackRate = now;
  }, LOOK_MS) };
  nudges.set(video, nudge);
}

/** No nudge: back to 1, the pitch kept as the browser keeps it. */
export function dropNudge(video: HTMLMediaElement): void {
  const nudge = nudges.get(video);
  if (nudge) {
    clearInterval(nudge.timer);
    nudges.delete(video);
    logEvent("Sync", "a speed nudge ended, played only while the sound was quiet", {
      rate: nudge.rate, wantedS: Number(((performance.now() - nudge.wantedAt) / 1000).toFixed(1)),
      playedS: Number((nudge.playedMs / 1000).toFixed(1)),
    });
  }
  if (video.playbackRate !== 1) video.playbackRate = 1;
  if (video.preservesPitch === false) video.preservesPitch = true;
}
