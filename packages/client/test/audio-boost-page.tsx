// Manual/DOM regression fixture: npm run dev -w packages/client, then open
// /test/audio-boost.html and Run, in Chrome. The volume above 100%
// (lib/audioBoost) on a real element and a real audio graph: the element
// below hearing and the capture of its sound through the gain, muting, a new
// stream on the same element, playing to the end, a write from elsewhere,
// back under 100%, and a capture with no sound in it. Then when a click is
// heard against when the element's clock says it plays, through the capture
// and through createMediaElementSource as the boost used to: on 28 October
// the second ran 48 ms late in this browser before any speaker's own delay,
// which the element's clock leaves out on that route. Nothing is heard: the
// boost's gain is listened to, not played. Not part of the production entry.
import { useState } from "react";
import { createRoot } from "react-dom/client";

const RATE = 48000;
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(f: () => boolean, ms: number) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (f()) return true; await pause(25); }
  return false;
}

/** A WAV: a tone, digital silence, or a click at each whole second. */
function wav(seconds: number, sound: { hz: number; amp: number } | "silence" | "clicks"): string {
  const n = seconds * RATE;
  const buf = new ArrayBuffer(44 + n * 2);
  const d = new DataView(buf);
  const s = (o: number, t: string) => [...t].forEach((c, i) => d.setUint8(o + i, c.charCodeAt(0)));
  s(0, "RIFF"); d.setUint32(4, 36 + n * 2, true); s(8, "WAVE"); s(12, "fmt ");
  d.setUint32(16, 16, true); d.setUint16(20, 1, true); d.setUint16(22, 1, true);
  d.setUint32(24, RATE, true); d.setUint32(28, RATE * 2, true); d.setUint16(32, 2, true); d.setUint16(34, 16, true);
  s(36, "data"); d.setUint32(40, n * 2, true);
  const put = (i: number, x: number) => d.setInt16(44 + i * 2, Math.round(x * 32767), true);
  if (sound === "clicks") {
    for (let k = 1; k < seconds; k++) for (let i = 0; i < 240; i++) put(k * RATE + i, Math.sin(2 * Math.PI * 1000 * i / RATE) * 0.8);
  } else if (sound !== "silence") {
    for (let i = 0; i < n; i++) put(i, Math.sin(2 * Math.PI * sound.hz * i / RATE) * sound.amp);
  }
  return URL.createObjectURL(new Blob([buf], { type: "audio/wav" }));
}

// Every gain the boost makes, so what it plays can be listened to instead of
// heard. Installed before the module makes any.
const gains: GainNode[] = [];
const createGain = AudioContext.prototype.createGain;
AudioContext.prototype.createGain = function (this: AudioContext) {
  const gain = createGain.call(this);
  gains.push(gain);
  return gain;
};
const boost = await import("../src/lib/audioBoost");

/** The newest boost's gain, taken off the speakers and onto an analyser. */
function tapGain(): { gain: GainNode; rms: () => number } {
  const gain = gains[gains.length - 1];
  gain.disconnect();
  const analyser = gain.context.createAnalyser();
  analyser.fftSize = 2048;
  gain.connect(analyser);
  const samples = new Float32Array(analyser.fftSize);
  return {
    gain,
    rms: () => {
      analyser.getFloatTimeDomainData(samples);
      return Math.sqrt(samples.reduce((sum, x) => sum + x * x, 0) / samples.length);
    },
  };
}

function element(src: string): HTMLVideoElement {
  const video = document.createElement("video");
  video.src = src;
  document.body.appendChild(video);
  return video;
}

const live = (video: HTMLMediaElement) => boost.routeOf(video).boostTrack === "live" && video.volume < 0.001;

/**
 * When a click is heard, against when the element's clock says that second
 * plays: ms, median of ten.
 */
async function lateness(route: "capture" | "element"): Promise<number> {
  const ctx = new AudioContext({ sampleRate: RATE });
  await ctx.resume();
  const processor = `registerProcessor("onset", class extends AudioWorkletProcessor {
    constructor() { super(); this.quiet = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) {
        if (Math.abs(ch[i]) > 0.3) { if (this.quiet > 4800) this.port.postMessage(currentFrame + i); this.quiet = 0; }
        else this.quiet++;
      }
      return true;
    }
  });`;
  await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([processor], { type: "text/javascript" })));
  const video = element(wav(12, "clicks"));
  const onset = new AudioWorkletNode(ctx, "onset");
  const silent = ctx.createGain();
  silent.gain.value = 0;
  onset.connect(silent).connect(ctx.destination);
  const heard: number[] = [];
  onset.port.onmessage = (e: MessageEvent<number>) => {
    const ts = ctx.getOutputTimestamp();
    heard.push((ts.performanceTime ?? 0) + (e.data / RATE - (ts.contextTime ?? 0)) * 1000);
  };
  let source: AudioNode;
  if (route === "capture") {
    video.volume = 0.0001;
    await video.play();
    const stream = (video as HTMLVideoElement & { captureStream: () => MediaStream }).captureStream();
    source = ctx.createMediaStreamSource(new MediaStream([stream.getAudioTracks()[0]]));
  } else {
    source = ctx.createMediaElementSource(video);
    source.connect(silent);
    await video.play();
  }
  source.connect(onset);
  const clock: [number, number][] = [];
  const t0 = performance.now();
  while (performance.now() - t0 < 11_000) {
    clock.push([performance.now(), video.currentTime]);
    await pause(1);
  }
  video.pause();
  await ctx.close();
  const at = (k: number) => {
    for (let i = 1; i < clock.length; i++) {
      const [p0, c0] = clock[i - 1];
      const [p1, c1] = clock[i];
      if (c0 < k && c1 >= k) return p0 + ((k - c0) / (c1 - c0)) * (p1 - p0);
    }
    return null;
  };
  const late = heard.map((h) => {
    let best: number | null = null;
    for (let k = 1; k < 12; k++) { const w = at(k); if (w != null && (best == null || Math.abs(h - w) < Math.abs(best))) best = h - w; }
    return best;
  }).filter((x): x is number => x != null).sort((a, b) => a - b);
  return Math.round(late[Math.floor(late.length / 2)] ?? NaN);
}

function Fixture() {
  const [running, setRunning] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  async function run() {
    setRunning(true);
    const out: string[] = [];
    const say = (ok: boolean | null, text: string) => {
      out.push(`${ok === null ? "" : ok ? "PASS " : "FAIL "}${text}`);
      setLines([...out]);
    };
    try {
      say(boost.boostAvailable(), "past 100% is offered in this browser");
      const video = element(wav(40, { hz: 440, amp: 0.5 }));
      await video.play();
      boost.setLevel(video, 0.6);
      say(video.volume === 0.6 && !boost.routeOf(video).boosted, "60% is the element's own volume, with no boost");
      boost.setLevel(video, 1.5);
      say(video.volume === 1 && boost.getLevel(video) === 1, "asked for 150%, it plays at 100% until the boost is up");
      say(await until(() => live(video), 3000), "the boost comes up");
      let tap = tapGain();
      await pause(400);
      // The tone is 0.354 RMS as mixed.
      say(video.volume === 0.0001 && boost.getLevel(video) === 1.5 && tap.gain.gain.value === 1.5,
        `at 150% the element plays 80 dB down and the gain carries 1.5 (element ${video.volume}, gain ${tap.gain.gain.value})`);
      say(Math.abs(tap.rms() - 0.354 * 1.5) < 0.03, `what the gain plays is the film's sound at 150% (RMS ${tap.rms().toFixed(3)})`);
      video.muted = true;
      await pause(200);
      say(tap.gain.gain.value === 0, "muting the element silences the boost too");
      video.muted = false;
      await pause(200);
      say(tap.gain.gain.value === 1.5, "and unmuting brings it back");

      video.src = wav(40, { hz: 880, amp: 0.5 });
      await video.play();
      say(await until(() => live(video), 3000), "a new stream on the same element: the boost takes its sound");
      await pause(400);
      say(Math.abs(tap.rms() - 0.354 * 1.5) < 0.03 && boost.getLevel(video) === 1.5, `still at 150% (RMS ${tap.rms().toFixed(3)})`);

      video.currentTime = 39.5;
      await until(() => video.ended, 3000);
      await pause(200);
      say(video.ended && video.volume === 1 && boost.getLevel(video) === 1.5, "played to its end: the element's own sound at 100%, the level kept");
      video.src = wav(40, { hz: 660, amp: 0.5 });
      await video.play();
      say(await until(() => live(video), 3000), "and the next stream is boosted again");

      video.volume = 0.25;
      await pause(100);
      say(boost.getLevel(video) === 0.25 && !boost.routeOf(video).boosted, "something else setting 25% ends the boost");

      boost.setLevel(video, 1.8);
      say(await until(() => live(video), 3000), "180%");
      tap = tapGain();
      await pause(400);
      say(Math.abs(tap.rms() - 0.354 * 1.8) < 0.03, `plays at 180% (RMS ${tap.rms().toFixed(3)})`);
      boost.setLevel(video, 0.7);
      say(video.volume === 0.7 && !boost.routeOf(video).boosted, "back to 70%: the element's own volume, no boost left");
      video.pause();

      const quiet = element(wav(20, "silence"));
      await quiet.play();
      boost.setLevel(quiet, 1.5);
      await until(() => live(quiet), 3000);
      await pause(7000);
      say(boost.getLevel(quiet) === 1 && quiet.volume === 1 && !boost.routeOf(quiet).boosted,
        "a capture that brings no sound in 6 s of playing gives the boost up for 100%");
      quiet.pause();

      const capture = await lateness("capture");
      const routed = await lateness("element");
      say(capture < 30 && capture < routed, `heard after the element's clock: ${capture} ms through the capture, ${routed} ms through createMediaElementSource`);
    } catch (e) {
      say(false, String(e));
    } finally {
      (window as unknown as { results?: string[] }).results = out;
      setRunning(false);
    }
  }
  return (
    <main>
      <h1>Volume boost</h1>
      <button disabled={running} onClick={() => void run()}>{running ? "Running…" : "Run"}</button>
      <pre>{lines.join("\n")}</pre>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
