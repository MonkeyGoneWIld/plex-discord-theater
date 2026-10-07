// A host and a viewer in one room, with the host's stream made to struggle.
//
//   npx tsx packages/client/test/sync-room-server.ts
//   npm run dev -w packages/client      → open /test/sync-room.html, Run
//
// Two real players (sync-player.tsx), each in its own frame like two people's
// Discord, in the real room the server runs — on different origins, as two
// people are on different machines (see sync-player.tsx). The host's
// connection is held to a little over the stream's own speed, so its buffer
// stays short; the viewer's is fast. Then the host's stream is held back twice
// — at the start, and in the middle — which is what a struggling host looks
// like.
//
// What must hold, because the room is the host and starts together:
//   - the viewer and the host start at the same moment, whichever of them is
//     slower to get its first picture — up to ten seconds, after which the
//     room starts without the slow one;
//   - while the host's picture is stopped, the viewer's is too, and never gets
//     more than a moment ahead of it;
//   - the viewer is never sent back: nobody sees the same seconds twice;
//   - once the host goes on, they are back together within a few seconds;
//   - the loading screen says "Loading…" or "Buffering…" and nothing else.
// With P2P on, the viewer's segments should carry the host through instead.
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type Event = { t: number; tag: string; msg: string; data: Record<string, unknown> };
type Report = { user: string; t: number; pos: number; paused: boolean; ready: number; waiting: boolean; text: string; joined: boolean };
type Sample = { t: number; host: Report; viewer: Report };

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const api = (path: string) => fetch(path).then((r) => r.json());

// What each player last reported, and everything it has logged.
const latest = new Map<string, Report>();
const events = new Map<string, Event[]>();
window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as Report & { kind?: string; events?: Event[] };
  if (m?.kind !== "sample") return;
  latest.set(m.user, m);
  events.set(m.user, [...(events.get(m.user) ?? []), ...(m.events ?? [])]);
});

const port = location.port;
const SRC = {
  viewer: `http://localhost:${Number(port) + 1}/test/sync-player.html?user=u-viewer&autojoin`,
  host: `http://localhost:${port}/test/sync-player.html?user=u-host`,
};

function Runner() {
  const [frames, setFrames] = useState(0);
  // The host starts only once the viewer has joined — clicked Join in its
  // frame, which is someone else's to do (see sync-player.tsx).
  const [hostOn, setHostOn] = useState(false);
  const [lines, setLines] = useState<string[]>([]);
  const [running, setRunning] = useState(false);

  async function waitFor<T>(get: () => T | null | undefined | false, ms: number, what: string): Promise<T> {
    for (const end = Date.now() + ms; Date.now() < end; await pause(100)) {
      const v = get();
      if (v) return v as T;
    }
    throw new Error(`timed out waiting for ${what}`);
  }
  const firstPlay = (user: string) => events.get(user)?.find((e) => e.tag === "Video" && e.msg === "playing")?.t;
  const hostFrame = useRef<HTMLIFrameElement>(null);
  /** A key pressed in the host's player — its own shortcuts. */
  const hostKey = (key: string) => {
    const win = hostFrame.current?.contentWindow as (Window & typeof globalThis) | null | undefined;
    win?.dispatchEvent(new win.KeyboardEvent("keydown", { key, bubbles: true }));
  };

  /**
   * The host skipping and pausing, through its own shortcuts: the room follows
   * a deliberate seek in either direction — a rewind is the one time anyone
   * is sent back — and a pause and resume.
   */
  async function runSeeks() {
    setRunning(true);
    const out: string[] = ["— the host seeking and pausing —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    latest.clear();
    events.clear();
    const together = (what: string, within = 1.5) => {
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      const apart = Math.abs(v.pos - h.pos);
      say(`${apart < within ? "PASS" : "FAIL"} ${what} (${apart.toFixed(2)}s apart, host at ${h.pos.toFixed(1)}s)`);
      return h.pos;
    };
    try {
      await api("/api/test/reset?p2p=0");
      setHostOn(false);
      setFrames((n) => n + 1);
      await waitFor(() => latest.get("u-viewer")?.joined, 60_000, "the viewer to join");
      setHostOn(true);
      await waitFor(() => firstPlay("u-host") && firstPlay("u-viewer"), 45_000, "both to start");
      await pause(6_000);

      const before = latest.get("u-host")!.pos;
      for (let i = 0; i < 3; i++) hostKey("ArrowRight");
      await waitFor(() => latest.get("u-host")!.pos > before + 25 && !latest.get("u-host")!.paused, 15_000, "the host's skip forward");
      await pause(4_000);
      const ahead = together("the viewer follows a skip forward");

      for (let i = 0; i < 2; i++) hostKey("ArrowLeft");
      await waitFor(() => latest.get("u-host")!.pos < ahead - 10, 15_000, "the host's skip back");
      await pause(4_000);
      together("the viewer follows the host back, because the host went back");

      hostKey(" ");
      await waitFor(() => latest.get("u-host")!.paused, 5_000, "the host to pause");
      await pause(2_000);
      say(`${latest.get("u-viewer")!.paused ? "PASS" : "FAIL"} the viewer pauses with the host`);
      together("and stays where the host is", 1);
      hostKey(" ");
      await waitFor(() => !latest.get("u-host")!.paused, 5_000, "the host to resume");
      await pause(4_000);
      say(`${!latest.get("u-viewer")!.paused ? "PASS" : "FAIL"} the viewer resumes with the host`);
      together("and they play on together", 1);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The viewer slow to get its first picture: the host waits for it, and they
   * start together — or, past ten seconds, the host starts without it.
   */
  async function runSlowViewer(stallMs: number) {
    setRunning(true);
    const out: string[] = [`— the viewer's first segments held back ${stallMs / 1000}s —`];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    latest.clear();
    events.clear();
    try {
      await api("/api/test/reset?p2p=0");
      setHostOn(false);
      setFrames((n) => n + 1);
      await waitFor(() => latest.get("u-viewer")?.joined, 60_000, "the viewer to join");
      // Held from the moment the host starts the film.
      await api(`/api/test/stall?user=u-viewer&ms=${stallMs}`);
      const began = Date.now();
      setHostOn(true);
      const hostStarted = await waitFor(() => firstPlay("u-host"), 45_000, "the host to start");
      const viewerStarted = await waitFor(() => firstPlay("u-viewer"), 45_000, "the viewer to start");
      const hostAfterS = (hostStarted - began) / 1000;
      if (stallMs <= 8000) {
        say(`${Math.abs(viewerStarted - hostStarted) < 700 ? "PASS" : "FAIL"} they start together (viewer ${viewerStarted - hostStarted} ms after the host)`);
        say(`${hostAfterS >= stallMs / 1000 - 1 ? "PASS" : "FAIL"} because the host waited for the viewer (host started ${hostAfterS.toFixed(1)}s in)`);
        const skipped = (events.get("u-viewer") ?? []).filter((e) => /settling onto the room|going to where the room/.test(e.msg));
        say(`${skipped.length === 0 ? "PASS" : "FAIL"} and the viewer skipped nothing to catch up (${skipped.length})`);
      } else {
        say(`${hostAfterS < 16 ? "PASS" : "FAIL"} the host doesn't wait for ever (started ${hostAfterS.toFixed(1)}s in)`);
        say(`${hostAfterS >= 9 ? "PASS" : "FAIL"} but it does wait about ten seconds first`);
        say(`${viewerStarted > hostStarted ? "PASS" : "FAIL"} and the viewer follows once it can (${((viewerStarted - hostStarted) / 1000).toFixed(1)}s later)`);
      }
      await pause(6_000);
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      const apart = Math.abs(v.pos - h.pos);
      say(`${apart < 1 && !v.paused && !h.paused ? "PASS" : "FAIL"} and they play on together (${apart.toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  async function run(p2p: boolean) {
    setRunning(true);
    const out: string[] = [`— ${p2p ? "with" : "without"} P2P —`];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    const samples: Sample[] = [];
    let sampler = 0;
    latest.clear();
    events.clear();
    try {
      await api(`/api/test/reset?p2p=${p2p ? 1 : 0}`);
      // The host's connection: one 3s segment every 2.6s, a little faster
      // than it plays. And its stream slow to start.
      await api("/api/test/pace?user=u-host&ms=2600");
      await api("/api/test/stall?user=u-host&ms=5000");
      setHostOn(false);
      setFrames((n) => n + 1);
      say("… click Join in the viewer's frame");
      await waitFor(() => latest.get("u-viewer")?.joined, 60_000, "the viewer to join");
      setHostOn(true);
      await waitFor(() => latest.has("u-host"), 20_000, "the host to load");
      sampler = window.setInterval(() => {
        const host = latest.get("u-host");
        const viewer = latest.get("u-viewer");
        if (host && viewer) samples.push({ t: Date.now(), host, viewer });
      }, 200);

      const hostStarted = await waitFor(() => firstPlay("u-host"), 45_000, "the host to start");
      const viewerStarted = await waitFor(() => firstPlay("u-viewer"), 45_000, "the viewer to start");
      say(`${Math.abs(viewerStarted - hostStarted) < 700 ? "PASS" : "FAIL"} the viewer and the host start together (viewer ${viewerStarted - hostStarted} ms after)`);
      const heldBeforeStart = samples.some((s) => s.viewer.waiting && s.viewer.text.includes("Loading…"));
      say(`${heldBeforeStart ? "PASS" : "FAIL"} and the viewer's screen says "Loading…" while it waits`);
      const wordy = samples.filter((s) => /Waiting for|Downloading at|Everyone starts|connection is/.test(s.viewer.text + s.host.text)).length;
      say(`${wordy === 0 ? "PASS" : "FAIL"} and nothing more than that (${wordy} samples said more)`);

      await pause(12_000);
      say("… holding the host's stream back for 8s");
      await api("/api/test/stall?user=u-host&ms=8000");
      const stallFrom = samples.length;
      if (p2p) {
        await pause(20_000);
        window.clearInterval(sampler);
        const stopped = samples.slice(stallFrom).filter((s) => !s.host.paused && s.host.ready < 3).length;
        say(`${stopped <= 2 ? "PASS" : "FAIL"} the viewer's segments carry the host through its stall (stopped in ${stopped} samples)`);
      } else {
        const hostStalled = await waitFor(() => {
          const h = latest.get("u-host");
          return h && !h.paused && h.ready < 3 ? h.t : null;
        }, 25_000, "the host's picture to stop");
        say(`(the host's picture stopped ${Math.round((hostStalled - samples[stallFrom].t) / 100) / 10}s after)`);
        await waitFor(() => { const h = latest.get("u-host"); return h && h.ready >= 3 && !h.paused; }, 30_000, "the host to go on");
        await pause(12_000);
        window.clearInterval(sampler);
      }

      const during = samples.slice(stallFrom);
      const maxAhead = Math.max(...during.map((s) => s.viewer.pos - s.host.pos));
      say(`${maxAhead < 1.5 ? "PASS" : "FAIL"} the viewer is never more than a moment ahead of the host (at most ${maxAhead.toFixed(2)}s)`);
      if (!p2p) {
        const held = during.some((s) => s.viewer.paused && s.viewer.waiting);
        say(`${held ? "PASS" : "FAIL"} the viewer holds while the host's picture is stopped`);
        const toldWhy = during.some((s) => /Loading…|Buffering…/.test(s.viewer.text));
        say(`${toldWhy ? "PASS" : "FAIL"} and the viewer's screen says it is buffering`);
      }

      const back = samples.slice(1)
        .map((s, i) => s.viewer.pos - samples[i].viewer.pos)
        .filter((d) => d < -0.05);
      say(`${back.length === 0 ? "PASS" : "FAIL"} the viewer is never sent back${back.length ? ` (${back.map((d) => d.toFixed(2)).join(", ")}s)` : ""}`);
      const rewinds = (events.get("u-viewer") ?? []).filter((e) =>
        /drift correction|correcting to room position/.test(e.msg) && Number(e.data.toS) < Number(e.data.fromS));
      say(`${rewinds.length === 0 ? "PASS" : "FAIL"} no correction moves the viewer backwards (${rewinds.length})`);

      const end = samples[samples.length - 1];
      const apart = Math.abs(end.viewer.pos - end.host.pos);
      say(`${apart < 1 ? "PASS" : "FAIL"} back together after the stall (${apart.toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      window.clearInterval(sampler);
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  return (
    <>
      <div className="bar">
        <button disabled={running} onClick={() => void run(false)}>{running ? "Running…" : "Run"}</button>
        <button disabled={running} onClick={() => void run(true)}>Run with P2P</button>
        <button disabled={running} onClick={() => void runSeeks()}>Seeks and pauses</button>
        <button disabled={running} onClick={() => void runSlowViewer(5000)}>Slow viewer</button>
        <button disabled={running} onClick={() => void runSlowViewer(20000)}>Very slow viewer</button>
        <pre id="results">{lines.join("\n")}</pre>
      </div>
      {frames > 0 && (
        <div className="frames" key={frames}>
          {/* The viewer first, so it is in the room when the host starts. */}
          <iframe title="viewer" src={SRC.viewer} allow="autoplay" />
          {hostOn ? <iframe ref={hostFrame} title="host" src={SRC.host} allow="autoplay" /> : <div />}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Runner />);
