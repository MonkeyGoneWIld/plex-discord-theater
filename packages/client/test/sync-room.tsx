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
//
// "Start-up" and "Host's downloads crawl" play a copied film instead (see
// sync-room-server.ts), every download held to a speed as Discord's proxy
// holds them: its first segment, ~10 MB, comes in parts and is in within a
// few seconds, and a host whose downloads crawl takes it from the viewer.
//
// "Messages" goes through everything the two are told while a film plays —
// switches of tracks and quality, a skip, a pause, another title — each
// pressed in that player's own menus, and checks each is told what it should
// be and nothing else.
//
// Open the page as /test/sync-room.html?whisper when the browser running it
// is hidden: a muted video in a page nobody can see is paused a few seconds
// in, and ?whisper plays the players unmuted at a whisper instead.
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type Event = { t: number; tag: string; msg: string; data: Record<string, unknown> };
type Report = { user: string; t: number; pos: number; paused: boolean; ready: number; waiting: boolean; text: string; joined: boolean;
  /** What the loading screen says, when it is up. */
  loading: string | null;
  /** How far along the seek bar shows, percent. */
  barPct: number };
type Sample = { t: number; host: Report; viewer: Report };

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const api = (path: string) => fetch(path).then((r) => r.json());

// What each player last reported, and everything it has logged — the current
// frames only: a frame being replaced can still report for a moment.
const latest = new Map<string, Report>();
const events = new Map<string, Event[]>();
let currentGen = 0;
/** New frames for a run, and nothing kept from the last one's. */
const nextFrames = (n: number) => {
  currentGen = n + 1;
  latest.clear();
  events.clear();
  return currentGen;
};
window.addEventListener("message", (e: MessageEvent) => {
  const m = e.data as Report & { kind?: string; events?: Event[]; gen?: string | null };
  if (m?.kind !== "sample" || m.gen !== String(currentGen)) return;
  latest.set(m.user, m);
  events.set(m.user, [...(events.get(m.user) ?? []), ...(m.events ?? [])]);
});

const port = location.port;
// ?whisper on this page is passed on to the players — see sync-player.tsx.
const extra = new URLSearchParams(location.search).has("whisper") ? "&whisper" : "";
/** Anything more for the host's player — where it resumes from. */
let hostQuery = "";
const src = (gen: number) => ({
  viewer: `http://localhost:${Number(port) + 1}/test/sync-player.html?user=u-viewer&autojoin${extra}&gen=${gen}`,
  host: `http://localhost:${port}/test/sync-player.html?user=u-host${extra}${hostQuery}&gen=${gen}`,
});

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
  const viewerFrame = useRef<HTMLIFrameElement>(null);
  /** The host's player, on this page's own origin: its fixture, to drive it. */
  const hostFixture = () => (hostFrame.current?.contentWindow as unknown as {
    fixture?: { newStream?: () => void; actions?: { sendSetCoHost: (id: string, v: boolean) => void } };
  } | null)?.fixture;
  /** Every report of both players, every 100ms, until stopped. */
  const sampleBoth = () => {
    const samples: Sample[] = [];
    const id = window.setInterval(() => {
      const host = latest.get("u-host");
      const viewer = latest.get("u-viewer");
      if (host && viewer) samples.push({ t: Date.now(), host, viewer });
    }, 100);
    return { samples, stop: () => window.clearInterval(id) };
  };
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
      setFrames(nextFrames);
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
      setFrames(nextFrames);
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

  /** When the room started after the host pressed play, and how much each had buffered by then. */
  async function startOnce(query: string, flows: Record<string, number>, uploadKbps = 0) {
    latest.clear();
    events.clear();
    await api(`/api/test/reset?${query}`);
    for (const [user, kbps] of Object.entries(flows)) await api(`/api/test/flow?user=${user}&kbps=${kbps}`);
    if (uploadKbps) await api(`/api/test/upload?kbps=${uploadKbps}`);
    setHostOn(false);
    setFrames(nextFrames);
    await waitFor(() => latest.get("u-viewer")?.joined, 60_000, "the viewer to join");
    const began = Date.now();
    setHostOn(true);
    const hostStarted = await waitFor(() => firstPlay("u-host"), 90_000, "the host to start");
    const viewerStarted = await waitFor(() => firstPlay("u-viewer"), 30_000, "the viewer to start");
    const aheadAt = (user: string) => Number(events.get(user)?.find((e) => e.tag === "Video" && e.msg === "playing")?.data.bufAheadS ?? NaN);
    // What the server sent the host before it started: each download, when it began and ended.
    const sent = (await api("/api/test/served") as Array<{ user: string; seg: string; at: number; ms: number; part?: string }>)
      .filter((x) => x.user === "u-host" && x.at - x.ms >= began - 1000 && x.at <= hostStarted + 500)
      .sort((a, b) => a.at - a.ms - (b.at - b.ms))
      .map((x) => `${x.seg}${x.part ? ` ${x.part}` : ""} ${((x.at - x.ms - began) / 1000).toFixed(1)}–${((x.at - began) / 1000).toFixed(1)}s`);
    return {
      sent,
      startS: (hostStarted - began) / 1000,
      apartMs: viewerStarted - hostStarted,
      hostAheadS: aheadAt("u-host"),
      viewerAheadS: aheadAt("u-viewer"),
      // Only this start's: the last one's players can still be reporting as they go.
      segments: (events.get("u-host") ?? []).filter((e) => e.tag === "Load" && e.t >= began),
    };
  }

  /**
   * Starting a copied film, every download held to 6 Mbps as Discord's proxy
   * holds them: its first segment, ~10 MB, fetched in parts and as one.
   */
  async function runStartup() {
    setRunning(true);
    const out: string[] = ["— starting a copied film, each download at 6 Mbps —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      const flows = { "u-host": 6000, "u-viewer": 6000 };
      const inParts = await startOnce("p2p=0&stream=copy", flows);
      say(`in parts: started ${inParts.startS.toFixed(1)}s after play, host ${inParts.hostAheadS.toFixed(1)}s buffered, viewer ${inParts.viewerAheadS.toFixed(1)}s, ${inParts.apartMs} ms apart`);
      for (const e of inParts.segments) say(`    segment ${e.data.seg}: ${e.data.MB} MB from ${e.data.from} in ${e.data.tookS}s (${e.data.Mbps} Mbps)`);
      say(`    sent: ${inParts.sent.join(", ")}`);
      const whole = await startOnce("p2p=0&stream=copy&parts=0", flows);
      say(`whole: started ${whole.startS.toFixed(1)}s after play, host ${whole.hostAheadS.toFixed(1)}s buffered, viewer ${whole.viewerAheadS.toFixed(1)}s, ${whole.apartMs} ms apart`);
      for (const e of whole.segments) say(`    segment ${e.data.seg}: ${e.data.MB} MB from ${e.data.from} in ${e.data.tookS}s (${e.data.Mbps} Mbps)`);
      const shared = await startOnce("p2p=1&stream=copy", flows);
      const took = (events.get("u-host") ?? []).concat(events.get("u-viewer") ?? []).filter((e) => e.tag === "P2P" && /taking the segment/.test(e.msg));
      say(`in parts, with P2P: started ${shared.startS.toFixed(1)}s after play, ${shared.apartMs} ms apart, ${took.length} segments taken from the other player`);
      say(`${inParts.startS < whole.startS / 2 ? "PASS" : "FAIL"} in parts it starts in under half the time`);
      say(`${shared.startS < inParts.startS + 1.5 ? "PASS" : "FAIL"} and players sharing segments start no later`);
      say(`${inParts.startS < 8 ? "PASS" : "FAIL"} and within eight seconds`);
      say(`${Math.abs(inParts.apartMs) < 700 ? "PASS" : "FAIL"} both start together`);
      say(`${inParts.hostAheadS < 15 ? "PASS" : "FAIL"} without a pile of buffer it waited for first (${inParts.hostAheadS.toFixed(1)}s)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host's downloads crawling at 0.8 Mbps each while the viewer's run at
   * 8: the host takes the first segment from the viewer instead of waiting on
   * its own, as the Count of Monte Cristo's host should have.
   */
  async function runHostCrawls() {
    setRunning(true);
    const out: string[] = ["— the host's downloads crawl, the viewer's don't —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      const r = await startOnce("p2p=1&stream=copy", { "u-host": 800, "u-viewer": 8000 });
      say(`started ${r.startS.toFixed(1)}s after play, ${r.apartMs} ms apart`);
      for (const e of r.segments) say(`    host's segment ${e.data.seg}: ${e.data.MB} MB from ${e.data.from} in ${e.data.tookS}s`);
      const took = (events.get("u-host") ?? []).filter((e) => e.tag === "P2P" && /taking the segment/.test(e.msg));
      say(`${took.length > 0 ? "PASS" : "FAIL"} the host takes the segment it waits on from the viewer (${took.map((e) => `seg ${e.data.seg} after ${e.data.afterS}s`).join(", ") || "never"})`);
      say(`${r.startS < 12 ? "PASS" : "FAIL"} so the room starts within twelve seconds, not the ~30 its own downloads would take`);
      say(`${Math.abs(r.apartMs) < 700 ? "PASS" : "FAIL"} both start together`);
      await pause(8_000);
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`${Math.abs(v.pos - h.pos) < 1 && !h.paused && !v.paused ? "PASS" : "FAIL"} and play on together (${Math.abs(v.pos - h.pos).toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host skipping a minute ahead in a copied film, past what the bot has
   * measured, so the stream is rebuilt there — Backrooms skipped to 25:54, and
   * the room went back to 0:59 and waited there for ever.
   */
  async function runCopySkip() {
    setRunning(true);
    const out: string[] = ["— the host skipping past what a copied film has measured —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    const samples: Sample[] = [];
    let sampler = 0;
    try {
      await startOnce("p2p=1&stream=copy&event=1", {}, 60_000);
      await pause(4_000);
      const from = latest.get("u-host")!.pos;
      sampler = window.setInterval(() => {
        const host = latest.get("u-host");
        const viewer = latest.get("u-viewer");
        if (host && viewer) samples.push({ t: Date.now(), host, viewer });
      }, 200);
      for (let i = 0; i < 6; i++) hostKey("ArrowRight");
      const target = from + 60;
      say(`… skipping from ${from.toFixed(1)}s to about ${target.toFixed(0)}s`);
      await waitFor(() => {
        const h = latest.get("u-host");
        const v = latest.get("u-viewer");
        return h && v && !h.paused && !v.paused && h.pos > target - 3 && v.pos > target - 3;
      }, 40_000, "both to play from where the host skipped to");
      const restarted = (events.get("u-host") ?? []).some((e) => e.tag === "Seek" && /restarting transcode/.test(e.msg));
      say(`${restarted ? "PASS" : "FAIL"} the stream was rebuilt at the new place, as a skip past a copy's end is`);
      await pause(5_000);
      window.clearInterval(sampler);
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`PASS both play from where the host skipped to (host at ${h.pos.toFixed(1)}s, viewer at ${v.pos.toFixed(1)}s)`);
      const wentBack = samples.filter((x, i) => i > 0 &&
        ((x.host.pos < target - 10 && samples[i - 1].host.pos >= target - 10) ||
         (x.viewer.pos < target - 10 && samples[i - 1].viewer.pos >= target - 10))).length;
      say(`${wentBack === 0 ? "PASS" : "FAIL"} and nobody goes back to where they skipped from (${wentBack})`);
      say(`${Math.abs(v.pos - h.pos) < 1 ? "PASS" : "FAIL"} together (${Math.abs(v.pos - h.pos).toFixed(2)}s apart)`);
      // What the viewer was told while the skip loaded.
      const told = samples.filter((x) => /Host is seeking…/.test(x.viewer.text)).length;
      const buffering = samples.filter((x) => /Buffering…/.test(x.viewer.text)).length;
      say(`${told > 0 && buffering === 0 ? "PASS" : "FAIL"} the viewer's screen says the host is seeking, not buffering (${told} and ${buffering} samples)`);
      // Its bar, while the skip loaded: at the place skipped to — the film
      // is two minutes — never back at the start, and never blank.
      const loadingBar = samples.filter((x) => x.viewer.loading !== null).map((x) => x.viewer.barPct);
      const offTarget = loadingBar.filter((p) => !(Math.abs(p - (target / 120) * 100) < 6)).length;
      say(`${loadingBar.length > 0 && offTarget === 0 ? "PASS" : "FAIL"} and its bar shows where the host skipped to all the while (${offTarget} of ${loadingBar.length} samples elsewhere${offTarget ? `: ${[...new Set(loadingBar.map((p) => p.toFixed(0)))].join(", ")}%` : ""})`);
      // Where the viewer's segment for the new place came from: the bot, not
      // left waiting on the host's.
      const landing = (events.get("u-viewer") ?? []).filter((e) => e.tag === "Load" && Number(e.data.seg) === Math.floor(target / 10)).pop();
      say(`the viewer's first segment at the new place: from ${landing?.data.from ?? "?"} in ${landing?.data.tookS ?? "?"}s`);
    } catch (err) {
      const h = latest.get("u-host");
      const v = latest.get("u-viewer");
      say(`FAIL ${String(err)} (host at ${h?.pos.toFixed(1)}s ${h?.paused ? "paused" : "playing"}, viewer at ${v?.pos.toFixed(1)}s)`);
    } finally {
      window.clearInterval(sampler);
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host skipping past what a copied film has measured and pausing a
   * moment later, before the new place has loaded: once it has, both pictures
   * sit paused there, with no loading screen over them.
   */
  async function runSkipThenPause() {
    setRunning(true);
    const out: string[] = ["— the host skipping and pausing at once —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      await startOnce("p2p=0&stream=copy&event=1", {}, 60_000);
      await pause(4_000);
      const from = latest.get("u-host")!.pos;
      for (let i = 0; i < 6; i++) hostKey("ArrowRight");
      const target = from + 60;
      await pause(1_900);
      hostKey(" ");
      say(`… skipped from ${from.toFixed(1)}s to about ${target.toFixed(0)}s and paused`);
      await pause(15_000);
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      const screen = (r: Report) => (r.text.match(/Loading…|Buffering…|Host is seeking…/) ?? ["nothing"])[0];
      say(`${h.paused && v.paused ? "PASS" : "FAIL"} both paused (host ${h.paused ? "paused" : "playing"}, viewer ${v.paused ? "paused" : "playing"})`);
      say(`${Math.abs(h.pos - target) < 3 && Math.abs(v.pos - target) < 3 ? "PASS" : "FAIL"} where the host skipped to (host at ${h.pos.toFixed(1)}s, viewer at ${v.pos.toFixed(1)}s)`);
      say(`${h.ready >= 2 && v.ready >= 2 ? "PASS" : "FAIL"} with their pictures in (readyState ${h.ready} and ${v.ready})`);
      say(`${screen(h) === "nothing" && screen(v) === "nothing" ? "PASS" : "FAIL"} and no loading screen over them (host: ${screen(h)}, viewer: ${screen(v)})`);
      hostKey(" ");
      await waitFor(() => !latest.get("u-host")!.paused && !latest.get("u-viewer")!.paused, 15_000, "both to play on");
      await pause(3_000);
      const h2 = latest.get("u-host")!;
      const v2 = latest.get("u-viewer")!;
      say(`${Math.abs(v2.pos - h2.pos) < 1 ? "PASS" : "FAIL"} and they play on together when the host resumes (${Math.abs(v2.pos - h2.pos).toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * A copied film with a four-second keyframe interval resumed 0.6s before the
   * end of its first segment. On a connection that will have the second
   * segment in before the first has played, everybody starts on the keyframe,
   * on the first segment alone — as soon as from a point the first segment
   * covers. On one that won't, everybody waits for the second, rather than
   * start and stop a few seconds later.
   */
  async function runKeyframeStart() {
    setRunning(true);
    const out: string[] = ["— a copy resumed in the last moments of its first segment —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    const firstPlayAt = (user: string) => Number(events.get(user)?.find((e) => e.tag === "Video" && e.msg === "playing")?.data.posS ?? NaN);
    const hostSaid = (re: RegExp) => (events.get("u-host") ?? []).find((e) => e.tag === "HLS" && re.test(e.msg));
    /** Stopped, the two of them, in the few seconds after starting. */
    const stopsAfterStart = async () => {
      let stopped = 0;
      for (let i = 0; i < 25; i++) {
        await pause(200);
        const h = latest.get("u-host");
        const v = latest.get("u-viewer");
        if (h && v && (h.paused || v.paused || h.ready < 3)) stopped++;
      }
      return stopped;
    };
    try {
      const fast = { "u-host": 12_000, "u-viewer": 12_000 };
      hostQuery = "&resume=41";
      const covered = await startOnce("p2p=0&stream=copy4&event=1", fast, 60_000);
      say(`fast, resumed at 0:41, 3s before its first segment ends: started ${covered.startS.toFixed(1)}s after play, at ${firstPlayAt("u-host").toFixed(2)}s`);
      hostQuery = "&resume=43.4";
      const late = await startOnce("p2p=0&stream=copy4&event=1", fast, 60_000);
      const hostAt = firstPlayAt("u-host");
      const viewerAt = firstPlayAt("u-viewer");
      const snap = hostSaid(/starting on the copy's keyframe/);
      say(`fast, resumed at 0:43.4, 0.6s before it ends: started ${late.startS.toFixed(1)}s after play, host at ${hostAt.toFixed(2)}s, viewer at ${viewerAt.toFixed(2)}s, ${late.apartMs} ms apart`);
      if (snap) say(`    the host's first segment at ${snap.data.firstMbps} Mbps, so the next in ${snap.data.nextInS}s`);
      say(`${snap && Math.abs(hostAt - 40) < 0.5 && Math.abs(viewerAt - 40) < 0.5 ? "PASS" : "FAIL"} both start on the keyframe the copy begins at, 0:40`);
      say(`${late.startS < covered.startS + 1 ? "PASS" : "FAIL"} as soon as from a point the first segment covers (${late.startS.toFixed(1)}s against ${covered.startS.toFixed(1)}s)`);
      say(`${Math.abs(late.apartMs) < 700 ? "PASS" : "FAIL"} together`);
      await pause(1_000);
      const h2 = latest.get("u-host")!;
      const v2 = latest.get("u-viewer")!;
      say(`${Math.abs(v2.pos - h2.pos) < 0.5 ? "PASS" : "FAIL"} and together a moment later (${(v2.pos - h2.pos).toFixed(2)}s apart)`);
      const fastStops = await stopsAfterStart();
      say(`${fastStops === 0 ? "PASS" : "FAIL"} and neither stops in the five seconds after (${fastStops} samples)`);

      const slow = { "u-host": 6000, "u-viewer": 6000 };
      const slowly = await startOnce("p2p=0&stream=copy4&event=1", slow, 20_000);
      const slowHostAt = firstPlayAt("u-host");
      const slowViewerAt = firstPlayAt("u-viewer");
      const held = hostSaid(/not starting on the copy's keyframe/);
      say(`slow, resumed at 0:43.4: started ${slowly.startS.toFixed(1)}s after play, host at ${slowHostAt.toFixed(2)}s, viewer at ${slowViewerAt.toFixed(2)}s, ${slowly.apartMs} ms apart`);
      if (held) say(`    the host's first segment at ${held.data.firstMbps} Mbps, so the next in ${held.data.nextInS}s`);
      say(`${held && Math.abs(slowHostAt - 43.4) < 0.5 && Math.abs(slowViewerAt - 43.4) < 0.5 ? "PASS" : "FAIL"} the next segment can't be in in time, so both wait for it and start where they were asked`);
      say(`${Math.abs(slowly.apartMs) < 700 ? "PASS" : "FAIL"} together`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      hostQuery = "";
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host skipping ten seconds ahead, inside what both have buffered: the
   * room goes straight on — no loading screen, nobody stopping.
   */
  async function runBufferedSkip() {
    setRunning(true);
    const out: string[] = ["— a skip inside the buffer —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    let sampler: ReturnType<typeof sampleBoth> | null = null;
    try {
      await startOnce("p2p=0", {});
      await pause(10_000);
      const from = latest.get("u-host")!.pos;
      sampler = sampleBoth();
      hostKey("ArrowRight");
      await pause(4_000);
      sampler.stop();
      const s = sampler.samples;
      const loadingHost = s.filter((x) => x.host.loading !== null).length;
      const loadingViewer = s.filter((x) => x.viewer.loading !== null).length;
      const stopped = s.filter((x) => x.host.paused || x.viewer.paused).length;
      const waited = s.filter((x) => x.viewer.waiting || x.host.waiting).length;
      const told = s.filter((x) => /Host is seeking…/.test(x.viewer.text)).length;
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`… skipped from ${from.toFixed(1)}s; 4s later the host is at ${h.pos.toFixed(1)}s, the viewer at ${v.pos.toFixed(1)}s`);
      say(`${h.pos > from + 12 ? "PASS" : "FAIL"} the host skipped`);
      say(`${loadingHost + loadingViewer === 0 ? "PASS" : "FAIL"} no loading screen on either (host ${loadingHost}, viewer ${loadingViewer} of ${s.length} samples)`);
      say(`${stopped === 0 ? "PASS" : "FAIL"} neither picture stopped (${stopped})`);
      say(`${waited === 0 ? "PASS" : "FAIL"} the room didn't wait for anybody (${waited})`);
      say(`${told > 0 ? "PASS" : "FAIL"} the viewer is told the host is seeking, in the corner (${told} samples)`);
      say(`${Math.abs(v.pos - h.pos) < 0.5 ? "PASS" : "FAIL"} together (${Math.abs(v.pos - h.pos).toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      sampler?.stop();
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host going back, in a copied film: twenty seconds, which the browser
   * keeps, and fifty, which the P2P engine still holds in its memory. Both
   * play straight on — no loading screen, nobody stopping, the room not
   * waiting — as a skip inside the buffer does.
   */
  async function runRewind() {
    setRunning(true);
    const out: string[] = ["— going back a little —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    let sampler: ReturnType<typeof sampleBoth> | null = null;
    const backBuffer = (user: string) => {
      const health = (events.get(user) ?? []).filter((e) => e.tag === "Health").pop();
      return health ? Number(health.data.posS) - Number(health.data.bufStartS) : NaN;
    };
    const rewind = async (presses: number) => {
      const from = latest.get("u-host")!.pos;
      sampler = sampleBoth();
      for (let i = 0; i < presses; i++) hostKey("ArrowLeft");
      await pause(4_000);
      sampler.stop();
      const x = sampler.samples;
      const loadingHost = x.filter((y) => y.host.loading !== null).length;
      const loadingViewer = x.filter((y) => y.viewer.loading !== null).length;
      const stopped = x.filter((y) => y.host.paused || y.viewer.paused).length;
      const waited = x.filter((y) => y.viewer.waiting || y.host.waiting).length;
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`back ${presses * 10}s from ${from.toFixed(1)}s: 4s later the host is at ${h.pos.toFixed(1)}s, the viewer at ${v.pos.toFixed(1)}s`);
      say(`${h.pos < from - presses * 10 + 6 ? "PASS" : "FAIL"} the host went back`);
      say(`${loadingHost + loadingViewer === 0 ? "PASS" : "FAIL"} no loading screen on either (host ${loadingHost}, viewer ${loadingViewer} of ${x.length} samples)`);
      say(`${stopped === 0 ? "PASS" : "FAIL"} neither picture stopped (${stopped})`);
      say(`${waited === 0 ? "PASS" : "FAIL"} the room didn't wait for anybody (${waited})`);
      say(`${Math.abs(v.pos - h.pos) < 0.5 ? "PASS" : "FAIL"} together (${Math.abs(v.pos - h.pos).toFixed(2)}s apart)`);
    };
    try {
      await startOnce("p2p=0&stream=copy", {});
      await pause(34_000);
      say(`after half a minute, kept behind the playhead: host ${backBuffer("u-host").toFixed(0)}s, viewer ${backBuffer("u-viewer").toFixed(0)}s`);
      await rewind(2);
      await pause(40_000);
      await rewind(5);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      (sampler as ReturnType<typeof sampleBoth> | null)?.stop();
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * What the loading screen says: "Host is seeking…" for a skip, and only a
   * skip — not the start of the next stream after one — and to a co-host too.
   */
  async function runSeekingWords() {
    setRunning(true);
    const out: string[] = ["— who is told the host is seeking —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    let sampler: ReturnType<typeof sampleBoth> | null = null;
    const playing = () => {
      const h = latest.get("u-host");
      const v = latest.get("u-viewer");
      return h && v && !h.paused && !v.paused && h.ready >= 3 && v.ready >= 3;
    };
    try {
      await startOnce("p2p=0&stream=copy&event=1", {}, 60_000);
      await pause(3_000);
      hostKey("ArrowRight");
      await pause(3_000);
      // A new stream, with a skip behind it in this room.
      sampler = sampleBoth();
      hostFixture()?.newStream?.();
      await pause(2_500);
      await waitFor(playing, 40_000, "both to play the new stream");
      sampler.stop();
      const said = new Set(sampler.samples.map((x) => x.viewer.loading).filter(Boolean));
      say(`the viewer's loading screen while the next stream started: ${[...said].join(", ") || "never up"}`);
      say(`${!said.has("Host is seeking…") ? "PASS" : "FAIL"} doesn't say the host is seeking when the host has started a stream`);
      say(`${said.has("Loading…") ? "PASS" : "FAIL"} it says it is loading`);

      // The viewer made a co-host, and the host skipping past what is measured.
      hostFixture()?.actions?.sendSetCoHost("u-viewer", true);
      await pause(3_000);
      sampler = sampleBoth();
      for (let i = 0; i < 6; i++) hostKey("ArrowRight");
      await pause(1_500);
      await waitFor(playing, 40_000, "both to play from the skip");
      sampler.stop();
      const coSaid = new Set(sampler.samples.map((x) => x.viewer.loading).filter(Boolean));
      say(`the co-host's loading screen through the host's skip: ${[...coSaid].join(", ") || "never up"}`);
      say(`${coSaid.has("Host is seeking…") ? "PASS" : "FAIL"} a co-host is told the host is seeking`);
      say(`${!coSaid.has("Buffering…") ? "PASS" : "FAIL"} not that it is buffering`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      sampler?.stop();
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * Everything the two players say while a film plays — on the loading
   * screen, over the held frame of a switch, in the corner — through each
   * thing the host or the viewer does, pressed in their own menus: what each
   * must be told, and nothing else, and nothing left up once the picture is
   * back. Each player's downloads are held back a moment at every change, so
   * what is said while it loads is up long enough to be seen.
   */
  async function runMessages() {
    setRunning(true);
    const out: string[] = ["— what each player is told —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    const SAID = /Host is switching (?:audio|subtitles|quality)…|Switching (?:audio|subtitles|quality)…|(?:Co-host|Host) is seeking…|Host paused the video|Loading…|Buffering…|Stream interrupted — Reconnecting\.\.\.|Stream lost|Reconnecting to the watch party…|Connection lost|Playback error[^\n]*/g;
    const saidIn = (r: Report) => r.text.match(SAID) ?? [];
    const press = (who: "host" | "viewer", labels: string[]) =>
      (who === "host" ? hostFrame : viewerFrame).current?.contentWindow?.postMessage({ kind: "press", press: labels }, "*");
    const hold = (ms: number) => Promise.all([api(`/api/test/stall?user=u-host&ms=${ms}`), api(`/api/test/stall?user=u-viewer&ms=${ms + 1000}`)]);
    const quiet = (r: Report | undefined) => !!r && !r.paused && r.ready >= 3 && saidIn(r).length === 0;
    /** Both playing, with nothing said, for two seconds on end. */
    const settled = async (what: string) => {
      let since = 0;
      await waitFor(() => {
        if (!quiet(latest.get("u-host")) || !quiet(latest.get("u-viewer"))) since = 0;
        else if (!since) since = Date.now();
        return since && Date.now() - since > 2000;
      }, 45_000, `both to play on with nothing on screen after ${what}`);
    };
    const list = (s: Set<string>) => [...s].join(", ") || "nothing";
    /**
     * One thing done, and what each player said from then until both play
     * on: only what is allowed, and the one it is about, when there is one.
     */
    const phase = async (what: string, act: () => unknown, allowed: { host: string[]; viewer: string[] }) => {
      const sampler = sampleBoth();
      try {
        await act();
        await pause(1_500);
        await settled(what);
      } catch (err) {
        const h = latest.get("u-host");
        const v = latest.get("u-viewer");
        say(`FAIL ${what}: ${String(err)} — host says ${list(new Set(h ? saidIn(h) : []))}, viewer says ${list(new Set(v ? saidIn(v) : []))}`);
      } finally {
        sampler.stop();
      }
      const seen = { host: new Set<string>(), viewer: new Set<string>() };
      for (const x of sampler.samples) {
        for (const m of saidIn(x.host)) seen.host.add(m);
        for (const m of saidIn(x.viewer)) seen.viewer.add(m);
      }
      for (const who of ["host", "viewer"] as const) {
        const extra = [...seen[who]].filter((m) => !allowed[who].includes(m));
        const main = allowed[who][0];
        const ok = extra.length === 0 && (!main || seen[who].has(main));
        say(`${ok ? "PASS" : "FAIL"} ${what}: the ${who} is told ${list(seen[who])}${allowed[who].length ? "" : " (should be nothing)"}${!ok && main && !seen[who].has(main) ? ` — never "${main}"` : ""}`);
        if (ok) continue;
        // What it said when, and what it was doing: each change.
        const t0 = sampler.samples[0]?.t ?? 0;
        let last = "";
        const changes: string[] = [];
        for (const x of sampler.samples) {
          const r = x[who];
          const now = `${saidIn(r).join("+") || "-"}${r.paused ? " paused" : ""}${r.waiting ? " waiting" : ""}`;
          if (now !== last) changes.push(`${((x.t - t0) / 1000).toFixed(1)}s ${now}`);
          last = now;
        }
        say(`    ${changes.slice(0, 24).join(" → ")}`);
      }
    };
    try {
      await phase("starting the film", () => startOnce("p2p=0&stream=copy4&event=1", {}), { host: ["Loading…"], viewer: ["Loading…"] });
      await pause(3_000);
      await phase("the host switches audio", async () => { await hold(2_000); press("host", ["Audio & Subtitles", "Audio", "Français (AAC Stereo)"]); },
        { host: ["Switching audio…"], viewer: ["Host is switching audio…"] });
      await phase("the host turns on a subtitle the players draw", () => press("host", ["Audio & Subtitles", "Subtitles", "English (SRT)"]),
        { host: [], viewer: [] });
      await phase("the host skips past what the copy has measured", async () => { await hold(2_000); for (let i = 0; i < 4; i++) hostKey("ArrowRight"); },
        { host: ["Loading…", "Buffering…"], viewer: ["Host is seeking…"] });
      await phase("the host picks a subtitle that is burned in", async () => { await hold(2_000); press("host", ["Audio & Subtitles", "Subtitles", "English (PGS)"]); },
        { host: ["Switching subtitles…"], viewer: ["Host is switching subtitles…"] });
      await phase("the host turns subtitles off", async () => { await hold(2_000); press("host", ["Audio & Subtitles", "Subtitles", "None"]); },
        { host: ["Switching subtitles…"], viewer: ["Host is switching subtitles…"] });
      await phase("the host pauses and plays on", async () => {
        hostKey(" ");
        await pause(2_500);
        hostKey(" ");
      }, { host: [], viewer: ["Host paused the video"] });
      await phase("the viewer switches its own audio", async () => { await hold(2_000); press("viewer", ["Audio & Subtitles", "Audio", "English (AAC Stereo)"]); },
        { host: [], viewer: ["Switching audio…"] });
      // Quality is everyone's own, the host's too — but the room is the
      // host's, and waits for the host's stream to come back.
      await phase("the host picks a lower quality", async () => { await hold(2_000); press("host", ["Audio & Subtitles", "Quality", "Up to 8 Mbps"]); },
        { host: ["Switching quality…"], viewer: ["Host is switching quality…"] });
      await phase("the host starts another title", async () => {
        await hold(2_000);
        (hostFrame.current?.contentWindow as unknown as { fixture?: { playTitle?: (k: string) => void } } | null)?.fixture?.playTitle?.("4343");
      }, { host: ["Loading…"], viewer: ["Loading…"] });
      await pause(3_000);
      await phase("the viewer picks a lower quality", async () => { await hold(2_000); press("viewer", ["Audio & Subtitles", "Quality", "Up to 8 Mbps"]); },
        { host: [], viewer: ["Switching quality…"] });
      await phase("the host goes back to the first title", async () => {
        await hold(2_000);
        (hostFrame.current?.contentWindow as unknown as { fixture?: { playTitle?: (k: string) => void } } | null)?.fixture?.playTitle?.("4242");
      }, { host: ["Loading…"], viewer: ["Loading…"] });
      const missing = [...(events.get("u-host") ?? []), ...(events.get("u-viewer") ?? [])].filter((e) => e.tag === "Fixture" && e.msg === "no such button");
      if (missing.length) say(`FAIL buttons not found: ${missing.map((e) => e.data.label).join(", ")}`);
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
      setFrames(nextFrames);
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
        <button disabled={running} onClick={() => void runStartup()}>Start-up</button>
        <button disabled={running} onClick={() => void runHostCrawls()}>Host's downloads crawl</button>
        <button disabled={running} onClick={() => void runCopySkip()}>Skip in a copy</button>
        <button disabled={running} onClick={() => void runSkipThenPause()}>Skip then pause</button>
        <button disabled={running} onClick={() => void runKeyframeStart()}>Keyframe start</button>
        <button disabled={running} onClick={() => void runBufferedSkip()}>Skip in the buffer</button>
        <button disabled={running} onClick={() => void runRewind()}>Rewind</button>
        <button disabled={running} onClick={() => void runSeekingWords()}>Seeking words</button>
        <button disabled={running} onClick={() => void runMessages()}>Messages</button>
        <pre id="results">{lines.join("\n")}</pre>
      </div>
      {frames > 0 && (
        <div className="frames" key={frames}>
          {/* The viewer first, so it is in the room when the host starts. */}
          <iframe ref={viewerFrame} title="viewer" src={src(frames).viewer} allow="autoplay" />
          {hostOn ? <iframe ref={hostFrame} title="host" src={src(frames).host} allow="autoplay" /> : <div />}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Runner />);
