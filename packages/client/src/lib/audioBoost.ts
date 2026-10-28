/**
 * Playing something louder than it was mixed.
 *
 * `video.volume` is capped at 1 by the HTML spec — it attenuates and nothing
 * else, so a quietly mastered film is as loud as it will ever get with the
 * slider at the top. Going past that means Web Audio and a GainNode.
 *
 * How the sound gets into Web Audio decides whether it stays in time with the
 * picture. The obvious way, createMediaElementSource, takes the element's
 * sound away from its own output, and Chrome then times the picture as if
 * that sound were heard the moment the graph takes it: it tells the media
 * clock the output adds no delay (WebAudioSourceProviderImpl::ProvideInput
 * passes a zero delay). The graph's buffering and the speakers' own delay —
 * a Bluetooth headset's is a fifth of a second — are then all sound behind
 * picture, for as long as the element lives, since that routing can't be
 * undone. Measured in this browser, the picture ran 48 ms ahead of the sound
 * even with an output that claims no delay at all.
 *
 * So the element keeps its own output, and with it the browser's timing of
 * the picture against that output, exactly as at 100%. What is boosted is a
 * capture of its sound (captureStream), which the browser takes before the
 * element's volume is applied: the element plays far below hearing, and the
 * capture goes through the gain to the same speakers. Both reach the speakers
 * the same way, so their delay is allowed for as at 100%; what is left is the
 * capture's own hand-over, 11 ms in the same measurement.
 *
 * Three things follow.
 *
 * Each new stream the element loads adds a new track to the capture, and the
 * old one stays listed but silent; every track ends when the element plays to
 * its end, and the next stream's comes back on the same capture. The boost
 * follows the newest track whenever one is added.
 *
 * Until a track is playing through the gain, the element plays its own sound
 * at 100%, so a boost that is not working is never silence.
 *
 * At 100% or below nothing of this exists: the capture is stopped and the
 * element plays as it always has. Where captureStream isn't there — Safari,
 * Firefox — the slider stops at 100%, rather than amplify through a route
 * that puts the sound out of time with the picture.
 */

import { logEvent, logWarn } from "./log";

/** 200%. The point past which amplifying a normal mix is mostly clipping. */
export const MAX_LEVEL = 2;

/** A volume slider's colour above 100%, where it is amplifying. */
export const BOOST_ACCENT = "#ff6b35";

/**
 * The element's own volume while the boost plays its sound: 80 dB down, far
 * below hearing, and not 0, so the browser goes on treating it as a player
 * with sound and timing its picture by its output.
 */
const UNHEARD = 0.0001;

/** What each element is set to, including the part `video.volume` cannot hold. */
const levels = new WeakMap<HTMLMediaElement, number>();

interface Boost {
  gain: GainNode;
  /** The element's capture. */
  stream: MediaStream;
  /** The capture's track the gain is playing, the newest one. */
  track: MediaStreamTrack | null;
  source: MediaStreamAudioSourceNode | null;
  /** Takes the listeners off and stops the capture. */
  stop: () => void;
}
const boosts = new WeakMap<HTMLMediaElement, Boost>();
/** Elements whose boost is being built, so a slider drag doesn't start ten. */
const building = new WeakSet<HTMLMediaElement>();
/** The most recent level asked for, which during a drag is not the one that
 *  started the boost building. */
const wantedLevels = new WeakMap<HTMLMediaElement, number>();

let ctx: AudioContext | null = null;
/** No Web Audio or no captureStream here, or a boost could not be built. Off for good. */
let unavailable = false;

type AudioContextCtor = typeof AudioContext;
type Capturable = HTMLMediaElement & { captureStream?: () => MediaStream };

function context(): AudioContext | null {
  if (unavailable) return null;
  if (ctx) return ctx;
  try {
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) { unavailable = true; return null; }
    const made = new Ctor();
    ctx = made;
    // A context that stops is every boosted player gone quiet while its
    // picture plays on — said, so the log shows when and why.
    made.addEventListener("statechange", () => {
      logEvent("Audio", "the boost's audio context changed", { state: made.state });
    });
    return made;
  } catch {
    unavailable = true;
    return null;
  }
}

/**
 * Get the context running, or say that it won't.
 *
 * A context created outside a user gesture starts suspended. Resuming is
 * allowed from inside one, which is where this is called from — the pointer
 * that dragged the slider past 100%.
 */
async function running(audio: AudioContext): Promise<boolean> {
  if (audio.state === "running") return true;
  try {
    await audio.resume();
  } catch {
    return false;
  }
  // Read into a plain string: the check above narrowed `state` away from
  // "running", and resuming is precisely the thing that puts it back.
  const state: string = audio.state;
  return state === "running";
}

/**
 * Play the capture's newest sound track through the gain, and stop the rest.
 *
 * The older tracks are the element's earlier streams, listed but silent from
 * the moment the next one loaded. The picture's tracks are stopped as soon as
 * they appear: copying frames is all they would do.
 */
function follow(video: HTMLMediaElement, boost: Boost): void {
  for (const track of boost.stream.getVideoTracks()) if (track.readyState === "live") track.stop();
  const tracks = boost.stream.getAudioTracks().filter((t) => t.readyState === "live");
  const newest = tracks[tracks.length - 1] ?? null;
  for (const track of tracks) if (track !== newest) track.stop();
  if (newest === boost.track && (newest === null || boost.source)) return;
  try { boost.source?.disconnect(); } catch { /* already gone */ }
  boost.source = null;
  boost.track = null;
  if (newest && ctx) {
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([newest]));
      source.connect(boost.gain);
      boost.source = source;
      boost.track = newest;
      listen(video, boost);
    } catch (e) {
      logWarn("Audio", "the boost could not take the stream's sound", { error: String(e) });
    }
  }
  apply(video);
}

/**
 * Make sure a new track carries sound: the element plays below hearing while
 * it is the boost's, so a track that brings nothing is silence. Sound is
 * looked for while the player plays, five times a second, and seen at once in
 * anything but digital silence; six seconds of playing without any, and the
 * boost is given up for the element's own sound at 100%.
 */
function listen(video: HTMLMediaElement, boost: Boost): void {
  const audio = ctx;
  const source = boost.source;
  if (!audio || !source) return;
  const analyser = audio.createAnalyser();
  analyser.fftSize = 2048;
  source.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  let playedMs = 0;
  const done = () => {
    clearInterval(timer);
    try { source.disconnect(analyser); } catch { /* already gone */ }
  };
  const timer = setInterval(() => {
    if (boosts.get(video) !== boost || boost.source !== source) { done(); return; }
    if (video.paused || video.seeking || video.readyState < 3) return;
    analyser.getFloatTimeDomainData(samples);
    if (samples.some((x) => x !== 0)) { done(); return; }
    playedMs += 200;
    if (playedMs < 6000) return;
    done();
    logWarn("Audio", "the boost's capture brought no sound in 6 s of playing, back to 100%", routeOf(video));
    dropBoost(video);
    levels.set(video, 1);
    apply(video);
  }, 200);
}

/** Whether the boost is what is heard: a capture track is playing through the gain. */
function hearing(boost: Boost | undefined): boolean {
  return !!boost?.source && boost.track?.readyState === "live";
}

/**
 * Build an element's boost, once its context is actually running.
 *
 * Returns null when there is no boost to be had — no Web Audio, no
 * captureStream, a context that will not start, or a capture that fails.
 */
async function buildBoost(video: HTMLMediaElement): Promise<Boost | null> {
  const existing = boosts.get(video);
  if (existing) return existing;
  if (typeof (video as Capturable).captureStream !== "function") { unavailable = true; return null; }
  const audio = context();
  if (!audio) return null;
  if (!(await running(audio))) return null;
  // Another call got there while this one was awaiting the resume.
  const raced = boosts.get(video);
  if (raced) return raced;

  let stream: MediaStream;
  try {
    stream = (video as Capturable).captureStream!();
  } catch (e) {
    logWarn("Audio", "no boost: the player's sound can't be captured", { error: String(e) });
    unavailable = true;
    return null;
  }
  const gain = audio.createGain();
  gain.gain.value = 0;
  gain.connect(audio.destination);
  const onTrack = () => { if (boosts.get(video) === boost) follow(video, boost); };
  // A new stream is loading: the track being played goes silent now, and the
  // next one is added when that stream's details arrive. Until then the
  // element is heard at 100%, so a stream whose track never comes is not
  // silence.
  const onEmptied = () => {
    if (boosts.get(video) !== boost) return;
    boost.track?.stop();
    follow(video, boost);
  };
  // The gain is silent whenever the element is muted: the capture is taken
  // before the element's volume and its mute alike.
  const onVolume = () => {
    if (boosts.get(video) !== boost) return;
    if (video.volume !== UNHEARD && video.volume < 1) {
      // Something else set the element's volume, which is the level now.
      levels.set(video, video.volume);
      dropBoost(video);
      return;
    }
    const level = levels.get(video) ?? 1;
    boost.gain.gain.value = hearing(boost) && level > 1 && !video.muted ? level : 0;
  };
  const boost: Boost = {
    gain, stream, track: null, source: null,
    stop: () => {
      stream.removeEventListener("addtrack", onTrack);
      stream.removeEventListener("removetrack", onTrack);
      video.removeEventListener("emptied", onEmptied);
      video.removeEventListener("loadedmetadata", onTrack);
      video.removeEventListener("playing", onTrack);
      video.removeEventListener("volumechange", onVolume);
      try { boost.source?.disconnect(); } catch { /* already gone */ }
      try { gain.disconnect(); } catch { /* already gone */ }
      for (const track of stream.getTracks()) track.stop();
      boost.source = null;
      boost.track = null;
    },
  };
  stream.addEventListener("addtrack", onTrack);
  // Every track goes when the element plays to its end.
  stream.addEventListener("removetrack", onTrack);
  video.addEventListener("emptied", onEmptied);
  // The track is added when the stream's details arrive; these two look again
  // in case it was added before this listened.
  video.addEventListener("loadedmetadata", onTrack);
  video.addEventListener("playing", onTrack);
  video.addEventListener("volumechange", onVolume);
  boosts.set(video, boost);
  follow(video, boost);
  return boost;
}

/** Stop an element's boost and leave it playing its own sound. */
function dropBoost(video: HTMLMediaElement): void {
  const boost = boosts.get(video);
  if (!boost) return;
  boosts.delete(video);
  boost.stop();
}

/**
 * Push the stored level at the element.
 *
 * At 100% or below it is `video.volume` alone. Above, while the capture is
 * playing through the gain, the gain carries the whole level and the element
 * plays below hearing; until then the element plays at 100%. A change that
 * only moves the gain fires no native event, so one is sent by hand — the
 * player's persistence and the control bar's slider both already listen for
 * volumechange, and this keeps them the only thing that has to.
 */
function apply(video: HTMLMediaElement): void {
  const level = levels.get(video) ?? video.volume;
  const boost = boosts.get(video);
  const boosted = level > 1 && hearing(boost);
  if (boost) boost.gain.gain.value = boosted && !video.muted ? level : 0;
  const volume = boosted ? UNHEARD : Math.min(1, level);
  if (video.volume !== volume) video.volume = volume;
  else video.dispatchEvent(new Event("volumechange"));
}

/**
 * Set an element's level, 0 to MAX_LEVEL, where 1 is the mix as authored.
 *
 * Anything above 1 takes effect once the boost is up, which is a turn or two
 * later; the level below 1 applies immediately either way, so a drag stays
 * responsive across the whole range.
 */
export function setLevel(video: HTMLMediaElement, level: number): void {
  const wanted = Math.min(MAX_LEVEL, Math.max(0, level));
  wantedLevels.set(video, wanted);

  if (wanted > 1 && !boosts.has(video)) {
    // Nothing above 100% is real until the boost is, so the stored level stays
    // at 100% until it is — otherwise the slider would sit at 150% claiming
    // something no one can hear.
    levels.set(video, 1);
    apply(video);
    if (unavailable || building.has(video)) return;
    building.add(video);
    void buildBoost(video)
      .then((boost) => {
        building.delete(video);
        if (!boost) return;
        // Where the slider ended up, not where it was when the drag crossed
        // 100% and set this going.
        const now = wantedLevels.get(video) ?? wanted;
        if (now <= 1) dropBoost(video);
        else logEvent("Audio", "playing louder than 100% through a capture of the player's sound", { volumePct: Math.round(now * 100), ...routeOf(video) });
        levels.set(video, now);
        apply(video);
      })
      .catch(() => { building.delete(video); });
    return;
  }

  if (wanted <= 1) dropBoost(video);
  levels.set(video, wanted);
  apply(video);
}

/**
 * What an element is set to, in the same 0..MAX_LEVEL the slider uses.
 *
 * Falls back to `video.volume` whenever the two could disagree — anything that
 * writes the element directly is the more recent answer, and below 100% the
 * two are the same number anyway.
 */
export function getLevel(video: HTMLMediaElement): number {
  const stored = levels.get(video);
  if (stored != null && stored > 1 && boosts.has(video)) {
    // Playing below hearing, or at 100% while the next stream's sound is
    // being picked up: either way the level is the stored one.
    if (video.volume === UNHEARD || video.volume >= 1) return stored;
  }
  return video.volume;
}

/**
 * Stop an element's boost for good, when the player that owns it goes. The
 * capture would otherwise hold its tracks and the gain its place in the
 * audio graph after the element has left the page.
 */
export function releaseBoost(video: HTMLMediaElement): void {
  // A boost still being built is dropped when it is done.
  wantedLevels.set(video, Math.min(1, wantedLevels.get(video) ?? 1));
  if (!boosts.has(video)) return;
  dropBoost(video);
  levels.set(video, 1);
  apply(video);
}

/**
 * How an element's sound reaches the speakers, for the logs: its level, and
 * whether the boost is playing it — and if so, whether its context is running
 * and whether its capture has a track to play.
 */
export function routeOf(video: HTMLMediaElement): Record<string, string | number | boolean> {
  const boost = boosts.get(video);
  const route: Record<string, string | number | boolean> = {
    volumePct: Math.round(getLevel(video) * 100),
    muted: video.muted,
    boosted: !!boost,
  };
  if (boost && ctx) {
    route.audioContext = ctx.state;
    route.sampleRate = ctx.sampleRate;
    route.boostTrack = hearing(boost) ? "live" : "none";
  }
  return route;
}

/**
 * Keep a boosted player audible: start the boost's context again if it has
 * stopped, and give the boost up — back to the element's own sound at 100% —
 * if its capture has had nothing to play. True when there was something to
 * do.
 */
export function keepBoostRunning(video: HTMLMediaElement): boolean {
  const boost = boosts.get(video);
  if (!boost || !ctx) return false;
  if (ctx.state !== "running") {
    const audio = ctx;
    logWarn("Audio", "the boost's audio context stopped under a playing player, starting it again", { state: audio.state });
    void audio.resume().catch(() => { /* needs a gesture; the next one on the page will do */ });
    return true;
  }
  if ((levels.get(video) ?? 1) > 1 && !hearing(boost)) {
    follow(video, boost);
    if (hearing(boost)) return false;
    // Not silence — the element plays at 100% meanwhile — but not what the
    // slider says either.
    logWarn("Audio", "the boost's capture has no sound to play, back to 100%", routeOf(video));
    dropBoost(video);
    levels.set(video, 1);
    apply(video);
    return true;
  }
  return false;
}

/** Whether going past 100% is possible here. False once it has been tried and failed. */
export function boostAvailable(): boolean {
  if (unavailable) return false;
  if (typeof HTMLMediaElement === "undefined") return false;
  return typeof (HTMLMediaElement.prototype as Capturable).captureStream === "function";
}
