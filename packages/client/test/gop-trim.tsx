// Does a cut behind the playhead freeze the picture? Plays a stream whose
// keyframes are ten seconds apart (test/.gop-stream), cuts what has been
// watched seven seconds into a segment — "old": five seconds behind the
// playhead, as the player used to; "safe": to the start of the segment before
// the one playing (lib/bufferTrim) — and watches the picture for ten seconds.
//   /test/gop-trim.html?mode=old   or   ?mode=safe
//
// The stream, made once (segments named .seg, since Vite takes .ts for
// TypeScript):
//   ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
//     -t 120 -c:v libx264 -preset veryfast -b:v 6M -g 300 -keyint_min 300 -sc_threshold 0 -bf 2 \
//     -c:a aac -b:a 128k -f hls -hls_time 10 -hls_playlist_type vod \
//     -hls_segment_filename "packages/client/test/.gop-stream/seg%03d.seg" packages/client/test/.gop-stream/index.m3u8
//
// What it showed: "old" at 27.5s cut to 22.5s, and the buffer came back
// starting at 30.0s — the next keyframe — with the playhead in the hole.
// "safe" cut to the start of the segment before, and the buffer around the
// playhead stayed whole. Start playback from the console if the browser
// won't autoplay it, unmuted at a whisper: a muted video in a hidden page is
// paused outright.
import Hls from "hls.js";
import { safeBackCutS } from "../src/lib/bufferTrim";

const mode = new URLSearchParams(location.search).get("mode") ?? "old";
const v = document.getElementById("v") as HTMLVideoElement;
const out = document.getElementById("out")!;
const lines: string[] = [];
const say = (s: string) => { lines.push(s); out.textContent = lines.join("\n"); };
const ranges = () => [...Array(v.buffered.length)].map((_, i) => `${v.buffered.start(i).toFixed(2)}-${v.buffered.end(i).toFixed(2)}`).join(" ");

const hls = new Hls({ backBufferLength: Infinity, maxBufferLength: 60 });
hls.loadSource("/test/.gop-stream/index.m3u8");
hls.attachMedia(v);
hls.on(Hls.Events.MANIFEST_PARSED, () => { v.currentTime = 20.5; v.play(); });

const result: Record<string, unknown> = { mode };
(window as unknown as { result: typeof result }).result = result;
let cut = false;
v.addEventListener("timeupdate", () => {
  if (cut || v.currentTime < 27.5) return;
  cut = true;
  const now = v.currentTime;
  const frags = hls.levels[hls.currentLevel]?.details?.fragments ?? [];
  const end = mode === "old" ? now - 5 : safeBackCutS(frags, now, now - 5);
  say(`${mode}: at ${now.toFixed(2)}, buffered ${ranges()}, cutting to ${end?.toFixed(2) ?? "nothing"}`);
  if (end !== null) hls.trigger(Hls.Events.BUFFER_FLUSHING, { startOffset: 0, endOffset: end, type: null });
  const samples: Array<[number, number, number]> = [];
  const started = performance.now();
  const id = setInterval(() => {
    samples.push([performance.now() - started, v.currentTime, v.readyState]);
    if (samples.length === 1) say(`after the cut: buffered ${ranges()}`);
    if (performance.now() - started < 10_000) return;
    clearInterval(id);
    // The longest stretch the playhead didn't move while playing.
    let longest = 0, since = samples[0][0], last = samples[0][1];
    for (const [t, pos] of samples) {
      if (pos > last + 0.01) { since = t; last = pos; }
      longest = Math.max(longest, t - since);
    }
    result.frozeForMs = Math.round(longest);
    result.endPos = Number(v.currentTime.toFixed(2));
    result.readyStates = [...new Set(samples.map((s) => s[2]))];
    say(`picture stood still for at most ${result.frozeForMs} ms; ended at ${result.endPos}; readyStates ${result.readyStates}`);
    result.done = true;
  }, 50);
});
