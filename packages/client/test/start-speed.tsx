// How long a copied film takes to start, and how long its picture stops, with
// every download held as one through Discord's proxy is.
//
//   PATH=<ffmpeg's folder>:$PATH npx tsx packages/client/test/sync-room-server.ts
//   npm run dev -w packages/client      → open /test/start-speed.html
//
// One player, the host alone, plays sync-room-server.ts's stream=sg — shaped
// like Steins;Gate's first episode as the bot copied it on 6 November, 11 and
// 17 MB segments first and 106 MB in 11.8 s from 21.3 s — from the start to
// ?untilS= (45), past the big one, once for each of ?splits=, ";" between
// them, each as the server's &split= takes it: "default" for split-segment.ts's
// own sizes, "4,6,1" for pieces of about 4 MB of segments of 6 MB or more and
// none under a second, "none" for none cut. ?runs= times each (1).
//
// Each download: ?kbps= (2000), its first byte after ?latencyMs= (300), the
// rest from ?slowMs= (1030) after that; all of them together ?totalKbps=
// (60000). That is Discord's proxy as 727 downloads measured it on 6 November
// (split-segment.ts): a second and a third to get going, then 1.5 to 2 Mbps.
// A service worker over the test pages makes it (proxy-sw.js), every download
// at once as over the proxy's HTTP/2: through the dev server a page has six.
//
// For each: how long the picture took to start, from when the player first
// asked for the stream; every stop after, where and for how long; and how
// long it took to play to ?untilS=. window.results has them, for a script,
// and window.raw each run's events, downloads and buffer appends and cuts.
// Open it as /test/start-speed.html?whisper when the browser is hidden — see
// sync-room.tsx. Hidden in the desktop app's browser pane, a page that has
// been silent a while has its timers woken once a minute at most: one run
// stopped 84.7 s where a dozen others stopped 25 to 26, the player's
// quarter-second checks a minute apart while its picture waited, silent. So
// with ?whisper a tone too quiet to hear plays all through, too.
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

type Event = { t: number; tag: string; msg: string; data: Record<string, unknown> };
const q = new URLSearchParams(location.search);
const num = (key: string, fallback: number) => (q.has(key) ? Number(q.get(key)) : fallback);
const splits = (q.get("splits") ?? "default").split(";").filter(Boolean);
const runs = num("runs", 1);
const flow = { kbps: num("kbps", 2000), latencyMs: num("latencyMs", 300), slowMs: num("slowMs", 1030) };
const totalKbps = num("totalKbps", 60000);
const untilS = num("untilS", 45);
const giveUpMs = num("giveUpMs", 240_000);
const whisper = q.has("whisper") ? "&whisper" : "";
const api = (path: string) => fetch(path).then((r) => r.json());
/** Something said to the service worker, and its answer. */
const toWorker = <T,>(message: unknown): Promise<T> => new Promise((resolve) => {
  const channel = new MessageChannel();
  channel.port1.onmessage = (e) => resolve(e.data as T);
  navigator.serviceWorker.controller!.postMessage(message, [channel.port2]);
});
type Logged = { kind: "playlist" | "segment"; url: string; part?: string | null; askedAt: number; firstAt?: number; doneAt?: number; bytes?: number; cut?: boolean };
const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The current frame's: a frame being replaced can still report. */
let gen = 0;
let events: Event[] = [];
let pos = 0;
window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as { kind?: string; gen?: string | null; pos?: number; events?: Event[] };
  if (m?.kind !== "sample" || m.gen !== String(gen)) return;
  pos = m.pos ?? 0;
  events.push(...(m.events ?? []));
});

export interface Result {
  split: string;
  run: number;
  /** How the first seven segments were cut. */
  layout: string[];
  /** From the player asking for the stream to its picture playing. */
  startS: number | null;
  /** In hand when it went, and why. */
  wentWith: Record<string, unknown> | null;
  stops: Array<{ atS: number; forS: number }>;
  /** From asking for the stream to playing past untilS. */
  toUntilS: number | null;
  /** Segments and pieces fetched, parts asked for, MB. */
  downloads: number;
  parts: number;
  MB: number;
  /** The first twelve fetched, when asked for and when in. */
  timeline: string[];
}
const results: Result[] = [];
(window as unknown as { results: Result[] }).results = results;
/** Each run as it went, to look into one: the player's events, every download, its buffer's appends and cuts. */
const raw: Array<{ split: string; run: number; askedAt: number | null; events: Event[]; logged: Logged[]; bufferOps: unknown[] }> = [];
(window as unknown as { raw: typeof raw }).raw = raw;

function Runner() {
  const [src, setSrc] = useState<string | null>(null);
  const [lines, setLines] = useState<string[]>([]);
  useEffect(() => {
    void (async () => {
      const out = [`each download ${flow.kbps} kbps, first byte at ${flow.latencyMs} ms, going ${flow.slowMs} ms after; ${totalKbps} kbps in all; playing to ${untilS} s`];
      const say = (line: string) => { out.push(line); setLines([...out]); };
      setLines([...out]);
      if (whisper) {
        const sound = new AudioContext();
        const tone = sound.createOscillator();
        const level = sound.createGain();
        level.gain.value = 0.001;
        tone.connect(level).connect(sound.destination);
        tone.start();
        void sound.resume().catch(() => {});
      }
      await navigator.serviceWorker.register("/test/proxy-sw.js", { scope: "/test/" });
      if (!navigator.serviceWorker.controller) {
        await new Promise((r) => navigator.serviceWorker.addEventListener("controllerchange", r, { once: true }));
      }
      for (const split of splits) {
        for (let run = 1; run <= runs; run++) {
          const reset = await api(`/api/test/reset?stream=sg${split === "default" ? "" : `&split=${split}`}`) as { layout?: string[] };
          await toWorker({ kind: "model", model: { ...flow, totalKbps } });
          gen++;
          events = [];
          pos = 0;
          setSrc(`/test/sync-player.html?user=u-host&newcomer${whisper}&gen=${gen}`);
          const began = Date.now();
          let reachedAt: number | null = null;
          while (Date.now() - began < giveUpMs) {
            if (pos >= untilS) { reachedAt = Date.now(); break; }
            await pause(200);
          }
          const logged = await toWorker<Logged[]>({ kind: "log" });
          // The player's appends to and cuts from the browser's buffer (sync-player.tsx).
          const fixture = (document.querySelector("iframe")?.contentWindow as unknown as { fixture?: { bufferOps?: unknown[] } } | null)?.fixture;
          const bufferOps = [...(fixture?.bufferOps ?? [])];
          setSrc(null);
          await toWorker({ kind: "model", model: null });
          const asked = logged.find((l) => l.kind === "playlist")?.askedAt ?? null;
          const served = logged.filter((l) => l.kind === "segment" && !l.url.endsWith("/init.mp4"));
          // Each segment or piece: asked for, and in, from when the stream was.
          const timeline = [...new Set(served.map((l) => l.url))].slice(0, 12).map((u) => {
            const of = served.filter((l) => l.url === u);
            const MB = of.reduce((n, l) => n + (l.bytes ?? 0), 0) / 1e6;
            const from = Math.min(...of.map((l) => l.askedAt));
            const to = Math.max(...of.map((l) => l.doneAt ?? 0));
            return `${u.split("/").pop()} ${MB.toFixed(1)}MB ${(((from - (asked ?? from)) / 1000)).toFixed(1)}→${((to - (asked ?? from)) / 1000).toFixed(1)}s`;
          });
          const plays = events.filter((e) => e.tag === "Video" && e.msg === "playing");
          const started = plays[0]?.t ?? null;
          const stops = events
            .filter((e) => e.tag === "Video" && e.msg === "waiting (buffer starved)" && started !== null && e.t > started)
            .map((w) => {
              const back = plays.find((p) => p.t > w.t);
              return { atS: Number(Number(w.data.posS).toFixed(1)), forS: Number((((back?.t ?? Date.now()) - w.t) / 1000).toFixed(1)) };
            });
          const went = events.find((e) => e.tag === "Load" && e.msg === "enough in hand to go on");
          const result: Result = {
            split, run, layout: reset.layout ?? [],
            startS: started !== null && asked !== null ? Number(((started - asked) / 1000).toFixed(1)) : null,
            wentWith: went?.data ?? null,
            stops,
            toUntilS: reachedAt !== null && asked !== null ? Number(((reachedAt - asked) / 1000).toFixed(1)) : null,
            downloads: new Set(served.map((s) => s.url)).size,
            parts: served.length,
            MB: Number((served.reduce((n, s) => n + (s.bytes ?? 0), 0) / 1e6).toFixed(1)),
            timeline,
          };
          results.push(result);
          raw.push({ split, run, askedAt: asked, events: [...events], logged, bufferOps });
          const stopped = stops.reduce((n, s) => n + s.forS, 0);
          say(`${split} #${run}: start ${result.startS ?? "never"} s` +
            (result.wentWith ? ` (went with ${result.wentWith.inHandS} s, ${result.wentWith.why})` : "") +
            ` · ${stops.length} stop${stops.length === 1 ? "" : "s"}, ${stopped.toFixed(1)} s` +
            (stops.length ? ` [${stops.map((s) => `${s.forS} s at ${s.atS}`).join(", ")}]` : "") +
            ` · to ${untilS} s of film: ${result.toUntilS ?? "not reached"} s` +
            ` · ${result.downloads} downloads, ${result.parts} parts, ${result.MB} MB`);
          say(`   ${result.timeline.join(" · ")}`);
          await pause(1500);
        }
      }
      say("done");
      (window as unknown as { done: boolean }).done = true;
    })();
  }, []);
  return (
    <>
      <pre>{lines.join("\n")}</pre>
      {src ? <iframe src={src} allow="autoplay" /> : null}
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Runner />);
