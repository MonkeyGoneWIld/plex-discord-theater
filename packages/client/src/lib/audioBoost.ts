/**
 * Playing something louder than it was mixed.
 *
 * `video.volume` is capped at 1 by the HTML spec — it attenuates and nothing
 * else, so a quietly mastered film is as loud as it will ever get with the
 * slider at the top. Going past that means Web Audio: the element's output is
 * routed into a GainNode, and gain above 1 is amplification.
 *
 * Two things make that worth being careful about.
 *
 * Routing an element through Web Audio is one-way. Once a
 * MediaElementAudioSourceNode exists for an element, its audio reaches the
 * speakers only through the graph — there is no putting it back. So the graph
 * is built when someone actually asks to go past 100% and at no other time. A
 * viewer who never touches the boost never takes on the risk of it.
 *
 * And a graph fed by a suspended AudioContext is silence, not quiet. Browsers
 * start a context suspended until a user gesture, so the source node is not
 * created until the context has actually reached "running" — building it first
 * and hoping would trade a working 100% for an inaudible 150%.
 *
 * Everything degrades the same way: if the boost cannot be had, the stored
 * level is clamped back to 100% and the untouched `video.volume` path carries
 * on exactly as it did before any of this existed.
 */

/** 200%. The point past which amplifying a normal mix is mostly clipping. */
export const MAX_LEVEL = 2;

/** What each element is set to, including the part `video.volume` cannot hold. */
const levels = new WeakMap<HTMLMediaElement, number>();
const gains = new WeakMap<HTMLMediaElement, GainNode>();
/** Elements whose graph is being built, so a slider drag doesn't start ten. */
const building = new WeakSet<HTMLMediaElement>();
/** The most recent level asked for, which during a drag is not the one that
 *  started the graph building. */
const wantedLevels = new WeakMap<HTMLMediaElement, number>();

let ctx: AudioContext | null = null;
/** No Web Audio here, or the graph could not be built. Boost is off for good. */
let unavailable = false;

type AudioContextCtor = typeof AudioContext;

function context(): AudioContext | null {
  if (unavailable) return null;
  if (ctx) return ctx;
  try {
    const Ctor: AudioContextCtor | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: AudioContextCtor }).webkitAudioContext;
    if (!Ctor) { unavailable = true; return null; }
    ctx = new Ctor();
    return ctx;
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
 * Build the graph for an element, once its context is actually running.
 *
 * Returns null when there is no boost to be had — no Web Audio, a context that
 * will not start, or an element something else has already routed.
 */
async function buildGraph(video: HTMLMediaElement): Promise<GainNode | null> {
  const existing = gains.get(video);
  if (existing) return existing;
  const audio = context();
  if (!audio) return null;
  if (!(await running(audio))) return null;
  // Another call got there while this one was awaiting the resume.
  const raced = gains.get(video);
  if (raced) return raced;

  let source: MediaElementAudioSourceNode | null = null;
  try {
    source = audio.createMediaElementSource(video);
    const gain = audio.createGain();
    source.connect(gain);
    gain.connect(audio.destination);
    gains.set(video, gain);
    return gain;
  } catch {
    // The source may exist even though the rest failed, in which case the
    // element's audio is now going nowhere. Wire it straight to the output so
    // it is at least audible at 100%.
    try { source?.connect(audio.destination); } catch { /* nothing left to try */ }
    unavailable = true;
    return null;
  }
}

/**
 * Push the stored level at the element.
 *
 * Below 100% it is `video.volume` alone; above, volume sits at 1 and the gain
 * carries the rest. A gain-only change fires no native event, so one is sent
 * by hand — the player's persistence and the control bar's slider both already
 * listen for volumechange, and this keeps them the only thing that has to.
 */
function apply(video: HTMLMediaElement): void {
  const level = levels.get(video) ?? video.volume;
  const gain = gains.get(video);
  if (gain) gain.gain.value = Math.max(1, level);
  const volume = Math.min(1, level);
  if (video.volume !== volume) video.volume = volume;
  else video.dispatchEvent(new Event("volumechange"));
}

/**
 * Set an element's level, 0 to MAX_LEVEL, where 1 is the mix as authored.
 *
 * Anything above 1 takes effect once the graph is up, which is a turn or two
 * later; the level below 1 applies immediately either way, so a drag stays
 * responsive across the whole range.
 */
export function setLevel(video: HTMLMediaElement, level: number): void {
  const wanted = Math.min(MAX_LEVEL, Math.max(0, level));
  wantedLevels.set(video, wanted);

  if (wanted > 1 && !gains.has(video)) {
    // Nothing above 100% is real until the graph is, so the stored level stays
    // at 100% until it is — otherwise the slider would sit at 150% claiming
    // something no one can hear.
    levels.set(video, 1);
    apply(video);
    if (unavailable || building.has(video)) return;
    building.add(video);
    void buildGraph(video)
      .then((gain) => {
        building.delete(video);
        if (!gain) return;
        // Where the slider ended up, not where it was when the drag crossed
        // 100% and set this going.
        levels.set(video, wantedLevels.get(video) ?? wanted);
        apply(video);
      })
      .catch(() => { building.delete(video); });
    return;
  }

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
  if (stored != null && stored > 1 && video.volume >= 1) return stored;
  return video.volume;
}

/** Whether going past 100% is possible at all. False once it has been tried and failed. */
export function boostAvailable(): boolean {
  return !unavailable;
}
