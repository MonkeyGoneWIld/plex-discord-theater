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
// Open the page as /test/sync-room.html?whisper when the browser running it
// is hidden: a muted video in a page nobody can see is paused a few seconds
// in, and ?whisper plays the players unmuted at a whisper instead.
import React, { useRef, useState } from "react";
import { createRoot } from "react-dom/client";

type Event = { t: number; tag: string; msg: string; data: Record<string, unknown> };
type Report = { user: string; t: number; pos: number; paused: boolean; ready: number; waiting: boolean; text: string; joined: boolean };
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
const src = (gen: number) => ({
  viewer: `http://localhost:${Number(port) + 1}/test/sync-player.html?user=u-viewer&autojoin${extra}&gen=${gen}`,
  host: `http://localhost:${port}/test/sync-player.html?user=u-host${extra}&gen=${gen}`,
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
   * Both players on one connection to the bot, 20 Mbps for the two of them, as
   * at one house. Once they have found each other close (the first stream
   * shows it), a skip that rebuilds the stream has the host fetch the new
   * place with the whole connection and the viewer take it from the host,
   * instead of each fetching it at half.
   */
  async function runSharedStart() {
    setRunning(true);
    const out: string[] = ["— a copied film, both players on one 20 Mbps connection to the bot —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    /** Play a while, then skip past what is measured: how long until both play again, and where the viewer's segment came from. */
    const skipAfterPlaying = async (query: string) => {
      const first = await startOnce(query, {}, 20_000);
      await pause(15_000);
      const from = latest.get("u-host")!.pos;
      const loadsBefore = (events.get("u-viewer") ?? []).filter((e) => e.tag === "Load").length;
      const asked = Date.now();
      for (let i = 0; i < 6; i++) hostKey("ArrowRight");
      const target = from + 60;
      await waitFor(() => {
        const h = latest.get("u-host");
        const v = latest.get("u-viewer");
        return h && v && !h.paused && !v.paused && h.pos > target - 3 && v.pos > target - 3;
      }, 60_000, "both to play from where the host skipped to");
      // The segment the picture waited on: the one the skip landed in.
      const viewerLoad = (events.get("u-viewer") ?? []).filter((e) => e.tag === "Load").slice(loadsBefore)
        .find((e) => Number(e.data.seg) === Math.floor(target / 10));
      return { startS: first.startS, skipS: (Date.now() - asked) / 1000, viewerFrom: viewerLoad?.data.from };
    };
    try {
      const alone = await skipAfterPlaying("p2p=0&stream=copy&event=1");
      say(`each fetching its own: started in ${alone.startS.toFixed(1)}s; a skip played again in ${alone.skipS.toFixed(1)}s`);
      const shared = await skipAfterPlaying("p2p=1&stream=copy&event=1");
      say(`sharing: started in ${shared.startS.toFixed(1)}s; a skip played again in ${shared.skipS.toFixed(1)}s, the viewer's segment from ${shared.viewerFrom ?? "?"}`);
      say(`${shared.viewerFrom === "another player" ? "PASS" : "FAIL"} after the skip the viewer takes the segment from the host, not the bot`);
      say(`${shared.skipS < alone.skipS * 0.85 ? "PASS" : "FAIL"} so the room plays again sooner than with each fetching its own`);
      await pause(5_000);
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`${Math.abs(v.pos - h.pos) < 1 && !h.paused && !v.paused ? "PASS" : "FAIL"} and they play on together (${Math.abs(v.pos - h.pos).toFixed(2)}s apart)`);
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
        <button disabled={running} onClick={() => void runSharedStart()}>Shared connection</button>
        <button disabled={running} onClick={() => void runCopySkip()}>Skip in a copy</button>
        <button disabled={running} onClick={() => void runSkipThenPause()}>Skip then pause</button>
        <pre id="results">{lines.join("\n")}</pre>
      </div>
      {frames > 0 && (
        <div className="frames" key={frames}>
          {/* The viewer first, so it is in the room when the host starts. */}
          <iframe title="viewer" src={src(frames).viewer} allow="autoplay" />
          {hostOn ? <iframe ref={hostFrame} title="host" src={src(frames).host} allow="autoplay" /> : <div />}
        </div>
      )}
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Runner />);
