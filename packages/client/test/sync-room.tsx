// A host and a viewer in one room, with the host's stream made to struggle.
//
//   npx tsx packages/client/test/sync-room-server.ts
//   npm run dev -w packages/client      → open /test/sync-room.html, Run
//
// Two real players (sync-player.tsx), each in its own frame like two people's
// Discord, in the real room the server runs — on different origins, as two
// people are on different machines (see sync-player.tsx). The host's
// connection is held to a little over the stream's own speed, so its buffer
// stays short; the viewer's is fast. Then the host's stream is held back — at
// the start, and in the middle, once for a moment it rides out on what it has
// in hand and once for long enough to stop it — which is what a struggling
// host looks like.
//
// What must hold, because the room is the host and starts together:
//   - the viewer and the host start at the same moment, whichever of them is
//     slower to get its first picture — up to ten seconds, after which the
//     room starts without the slow one;
//   - while the host's picture is stopped, the viewer's is too, and never gets
//     more than a moment ahead of it;
//   - the viewer is never sent back: nobody sees the same seconds twice;
//   - once the host goes on, they are back together within a few seconds;
//   - the loading screen says "Loading…" or "Buffering…" and nothing else —
//     or "Catching up to host · N s" while one waits ahead of the room.
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
  bothQuery = "";
  return currentGen;
};
/** New frames, with `query` for both players — see bothQuery. */
const nextFramesWith = (query: string) => (n: number) => {
  const gen = nextFrames(n);
  bothQuery = query;
  return gen;
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
/** And for both, for one run's frames — ?timerFrames, say: see sync-player.tsx. */
let bothQuery = "";
/** And for the viewer's. */
let viewerQuery = "";
const src = (gen: number) => ({
  viewer: `http://localhost:${Number(port) + 1}/test/sync-player.html?user=u-viewer&autojoin${extra}${viewerQuery}${bothQuery}&gen=${gen}`,
  host: `http://localhost:${port}/test/sync-player.html?user=u-host${extra}${hostQuery}${bothQuery}&gen=${gen}`,
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
    fixture?: { newStream?: () => void; actions?: { sendSetCoHost: (id: string, v: boolean) => void; sendPromoteHost: (id: string) => void } };
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
   * The viewer slow to get its first picture: the room starts with the host's
   * picture, waiting for nobody else's, and the viewer comes in where the room
   * is once it can.
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
      say(`${hostAfterS < Math.min(stallMs / 1000 - 1, 6) ? "PASS" : "FAIL"} the host starts without waiting for the viewer (started ${hostAfterS.toFixed(1)}s in)`);
      say(`${viewerStarted > hostStarted ? "PASS" : "FAIL"} and the viewer follows once it can (${((viewerStarted - hostStarted) / 1000).toFixed(1)}s later)`);
      await pause(3_000);
      say(`${apartNow() < 1 ? "PASS" : "FAIL"} in step with the room seconds after it starts (${apartNow().toFixed(2)}s apart)`);
      await pause(3_000);
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

  /** How far apart the two players are, by their latest reports. */
  const apartNow = () => {
    const h = latest.get("u-host");
    const v = latest.get("u-viewer");
    return h && v ? Math.abs(v.pos - h.pos) : NaN;
  };

  /** When the room started after the host pressed play, and how much each had buffered by then. */
  async function startOnce(query: string, flows: Record<string, number>, uploadKbps = 0, frameQuery = "") {
    latest.clear();
    events.clear();
    await api(`/api/test/reset?${query}`);
    for (const [user, kbps] of Object.entries(flows)) await api(`/api/test/flow?user=${user}&kbps=${kbps}`);
    if (uploadKbps) await api(`/api/test/upload?kbps=${uploadKbps}`);
    setHostOn(false);
    // The new run's number now, not when the page next draws: until then the
    // last run's players still report under the old one, and what they said
    // counted for this run — Keyframe start after the slow skip took the old
    // host's "playing" for its own start, and timed it at −12 s.
    const gen = (frameQuery ? nextFramesWith(frameQuery) : nextFrames)(currentGen);
    setFrames(gen);
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
      segments: (events.get("u-host") ?? []).filter((e) => e.tag === "Load" && e.msg === "segment in" && e.t >= began),
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
      await pause(3_000);
      const inStepS = apartNow();
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
      say(`${inStepS < 1 ? "PASS" : "FAIL"} the viewer in step with the room seconds after it starts (${inStepS.toFixed(2)}s apart)`);
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
      say(`    the viewer started ${r.apartMs} ms after the host, the room waiting for nobody but it`);
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
  /**
   * The host skipping a minute ahead inside what a copied film lists, past
   * what it holds, while the segments ahead of where it was are still coming
   * in — every download sharing one 30 Mbps connection, as the bot's upload is
   * shared. Played in place, the new place should be in within a few seconds;
   * it once sat six seconds on nothing and then rebuilt the stream anyway
   * (The Bourne Identity, 11 October).
   */
  async function runCopySkipInPlace(p2p: boolean, uploadKbps = 30_000, skipS = 60) {
    setRunning(true);
    const slow = uploadKbps < 20_000;
    // Three minutes is past the two Plex's transcodes are restarted beyond
    // (FAR_SEEK_THRESHOLD_S), in a copy listed to its end, as the ffmpeg
    // engine's are a minute in.
    const far = skipS > 120;
    const out: string[] = [`— the host skipping ${skipS}s ahead inside a copy, ${p2p ? "with" : "without"} P2P, everything at ${uploadKbps / 1000} Mbps —`];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      await startOnce(`p2p=${p2p ? 1 : 0}&stream=${far ? "copy4long" : "copy4"}&event=1&eventS=${far ? 300 : 120}`, {}, uploadKbps);
      await pause(slow ? 20_000 : 8_000);
      const from = latest.get("u-host")!.pos;
      const skippedAt = Date.now();
      for (let i = 0; i < skipS / 10; i++) hostKey("ArrowRight");
      const target = from + skipS;
      say(`… skipping from ${from.toFixed(1)}s to about ${target.toFixed(0)}s`);
      const playing = (who: string) => {
        const r = latest.get(who);
        return !!r && !r.paused && r.ready >= 3 && r.pos > target - 3 && r.pos < target + 20;
      };
      await waitFor(() => playing("u-host") && playing("u-viewer"), 60_000, "both to play from where the host skipped to");
      const tookS = (Date.now() - skippedAt) / 1000;
      const host = events.get("u-host") ?? [];
      const starved = host.some((e) => e.tag === "Seek" && /in-place seek starved/.test(e.msg));
      const restarted = host.some((e) => e.tag === "Seek" && /restarting transcode|→ restart/.test(e.msg));
      say(`${!starved && !restarted ? "PASS" : "FAIL"} the host's picture for the new place came in place, without the skip starving or the stream being rebuilt (${starved ? "starved" : "came"}${restarted ? ", rebuilt" : ""})`);
      // Each player needs two four-second segments of about 4.4 MB to start
      // there, on the one connection they share: 17.6 MB, 4.7s of it at 30
      // Mbps and 17.6s at 8 — then the skip's own half second, and a little
      // over. Sharing them as they did before, the 30 Mbps skip took nine.
      // At 8, the parts of a segment either player was fetching as the host
      // skipped come in too, a few MB, whatever the player calls off: the dev
      // server's proxy doesn't pass that on to this server. 18 to 22 seconds.
      const limitS = slow ? 24 : 7.5;
      say(`${tookS < limitS ? "PASS" : "FAIL"} both playing there ${tookS.toFixed(1)}s after the skip (under ${limitS}s)`);
      // What the test server sent the host from a little before the skip:
      // which segment, which part, when it finished and how long it took.
      const served = (await api("/api/test/served")) as Array<{ user: string; seg: string; at: number; part?: string; ms?: number; askedAt?: number; cut?: boolean }>;
      const around = served.filter((x) => x.user === "u-host" && x.at >= skippedAt - 3000 && x.at <= skippedAt + tookS * 1000 + 500)
        .map((x) => `${x.seg}${x.part ? ` part ${x.part}` : ""} asked ${(((x.askedAt ?? x.at) - skippedAt) / 1000).toFixed(1)}s, ${x.cut ? "cut off" : "done"} ${((x.at - skippedAt) / 1000).toFixed(1)}s`);
      say(`    sent to the host: ${around.join(", ") || "nothing"}`);
      const asked = host.filter((e) => e.tag === "Fetch" && e.t >= skippedAt - 3000 && e.t <= skippedAt + tookS * 1000)
        .map((e) => `${((e.t - skippedAt) / 1000).toFixed(1)}s ${e.msg} ${String(e.data.seg)} ${String(e.data.part)}`);
      say(`    the host asked: ${asked.join(", ") || "nothing"}`);
      const seekLog = host.filter((e) => e.tag === "Seek" && e.t >= skippedAt - 500).map((e) => e.msg);
      say(`    ${seekLog.join(" → ")}`);
    } catch (err) {
      const h = latest.get("u-host");
      const v = latest.get("u-viewer");
      say(`FAIL ${String(err)} (host at ${h?.pos.toFixed(1)}s ${h?.paused ? "paused" : "playing"}, viewer at ${v?.pos.toFixed(1)}s)`);
    } finally {
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The start of a title's preview frames fetched on its page — by the host
   * and the viewer alike, since either can look along the seek bar — and the
   * seek bar taking it from there as the film starts, instead of asking for it
   * beside the first segments. Plex takes two and a half seconds to start
   * sending each pass, as it can on a big file. Then the same start straight
   * from Play, the seek bar asking for it itself, as before.
   */
  async function runPreviewAhead() {
    setRunning(true);
    const out: string[] = ["— the preview frames' first pass, fetched on the title's page —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    type Sent = { user: string; pass: number | null; askedAt: number; at: number; bytes: number };
    const said = (who: string, msg: RegExp) => (events.get(who) ?? []).find((e) => e.tag === "Preview" && msg.test(e.msg));
    const playingAt = (who: string) => (events.get(who) ?? []).find((e) => e.tag === "Video" && e.msg === "playing")?.t ?? NaN;
    try {
      for (const ahead of [true, false]) {
        hostQuery = ahead ? "&titlePage=4000" : "";
        viewerQuery = ahead ? "&titlePage" : "";
        // Downloads slow enough that the picture takes a few seconds to start,
        // as it does on a real connection: the frames from the title's page
        // are on the seek bar meanwhile.
        await startOnce("p2p=0&previews=1&previewDelayMs=2500", ahead ? { "u-host": 1200, "u-viewer": 1200 } : {});
        await waitFor(() => !!said("u-host", /^frame index ready$/) && !!said("u-viewer", /^frame index ready$/), 20_000, "both seek bars' frames");
        say(ahead ? "on the title's page first:" : "straight to Play, as before:");
        const firstSent = (await api("/api/test/previews")) as Sent[];
        for (const who of ["u-host", "u-viewer"]) {
          const accepted = said(who, /^transfer accepted$/);
          const firsts = firstSent.filter((x) => x.user === who && x.pass === 0);
          const lateMs = said(who, /^frame index ready$/)!.t - playingAt(who);
          say(`    ${who}: pass 0 sent ${firsts.length}×, its frames ready ${lateMs <= 0 ? `${-lateMs} ms before` : `${lateMs} ms after`} the picture started${accepted?.data.fetched ? ` — ${String(accepted.data.fetched)}` : ""}`);
          if (ahead) {
            say(`${accepted?.data.fetched ? "PASS" : "FAIL"} ${who}'s seek bar took the first pass fetched on the title's page`);
            say(`${firsts.length === 1 ? "PASS" : "FAIL"} which was sent once (${firsts.length})`);
            say(`${lateMs <= -1000 ? "PASS" : "FAIL"} and its frames were there while the picture was still loading`);
          } else {
            // Twice, the first called off: the seek bar's frames effect runs
            // again a moment after the picture starts.
            say(`${firsts.length >= 1 && accepted && !accepted.data.fetched ? "PASS" : "FAIL"} ${who}'s seek bar asks for the first pass itself`);
          }
        }
        // The later passes follow on from it as the buffer allows.
        await waitFor(() => !!said("u-host", /^frames (in)?complete$/), 60_000, "the host's frames to finish");
        const done = said("u-host", /^frames (in)?complete$/)!;
        const passes = ((await api("/api/test/previews")) as Sent[]).filter((x) => x.user === "u-host").map((x) => x.pass);
        say(`${done.msg === "frames complete" ? "PASS" : "FAIL"} the later passes follow: ${String(done.data.ready)} of ${String(done.data.frames)} frames (passes sent to the host: ${passes.join(", ")})`);
      }
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      hostQuery = "";
      viewerQuery = "";
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * A viewer joining a film already playing, its downloads only a little
   * faster than the film — as monkey26 rejoining May at 3:03 on 12 October.
   * It started on the first half second it had, stopped, fell nine seconds
   * behind, was jumped into a segment it hadn't got, stopped again, and once
   * more: three stops in twenty seconds. A viewer behind the room now goes a
   * little past it and waits there for it while that part comes.
   */
  async function runLateJoin() {
    setRunning(true);
    const out: string[] = ["— a viewer joining a film already playing, on a modest connection —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      latest.clear();
      events.clear();
      await api("/api/test/reset?p2p=0&stream=copy4&event=1&eventS=120");
      await api("/api/test/flow?user=u-viewer&kbps=3000");
      viewerQuery = "&latejoin";
      setHostOn(false);
      setFrames(nextFrames(currentGen));
      setHostOn(true);
      await waitFor(() => { const h = latest.get("u-host"); return !!h && !h.paused && h.pos > 30; }, 90_000, "the host 30s in");
      const joinedAt = Date.now();
      (viewerFrame.current?.contentWindow as Window | null | undefined)?.postMessage({ kind: "press", press: ["Join"] }, "*");
      const firstAt = await waitFor(() => firstPlay("u-viewer"), 60_000, "the viewer to play");
      await pause(30_000);
      const viewer = (events.get("u-viewer") ?? []).filter((e) => e.t >= firstAt);
      // Stopped while playing — not paused on purpose, waiting for the room.
      const stops = viewer.filter((e) => e.tag === "Video" && /buffer starved/.test(e.msg) && e.data.paused === false);
      const past = viewer.filter((e) => /going past it/.test(e.msg));
      const jumps = viewer.filter((e) => /heartbeat drift correction/.test(e.msg));
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`joined with the host at ${(h.pos - (Date.now() - joinedAt) / 1000).toFixed(0)}s; first frame ${((firstAt - joinedAt) / 1000).toFixed(1)}s after joining`);
      say(`    after it: ${stops.length} stop(s), ${past.length} wait(s) past the room, ${jumps.length} jump(s) to it`);
      for (const e of [...past, ...jumps]) say(`    ${e.msg} ${JSON.stringify({ driftS: e.data.driftS, toS: e.data.toS, leadS: e.data.leadS, bufAheadS: e.data.bufAheadS })}`);
      say(`${stops.length <= 1 ? "PASS" : "FAIL"} it stops no more than once after it starts (${stops.length})`);
      say(`${jumps.length === 0 ? "PASS" : "FAIL"} and is never jumped into what it hasn't got (${jumps.length})`);
      say(`${Math.abs(v.pos - h.pos) < 1 && !v.paused ? "PASS" : "FAIL"} together thirty seconds on (${(v.pos - h.pos).toFixed(2)}s apart${v.paused ? ", the viewer paused" : ""})`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      viewerQuery = "";
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host back from a pop-out in a browser that can't play the room's
   * stream — HEVC, which the viewer plays — and put on a stream of its own,
   * from where the room is. On 18 October monkey26, back in Firefox, had the
   * room wait for that stream's picture, and blah0391 stopped with a minute
   * and a half in hand. It catches up with the room as one back on the
   * room's own stream does, and the room plays on without it until then.
   *
   * `slow`: its stream comes in little faster than it plays, and soon after it
   * catches up, for a while, slower — as monkey26's re-encode did later that
   * day, when it was in step with 8.8 s in hand, ran dry 9 s on, and the room
   * waited 14 s for it. It catches up again, the room playing on.
   */
  async function runHostBackOwnStream(slow = false) {
    setRunning(true);
    const out: string[] = [slow
      ? "— the host back where it can't play the room's stream, on a stream that barely keeps up —"
      : "— the host back from a pop-out where it can't play the room's stream —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    const hostWin = () => hostFrame.current?.contentWindow as (Window & typeof globalThis) | null | undefined;
    const after = (user: string, t: number, msg: RegExp) => (events.get(user) ?? []).filter((e) => e.t >= t && msg.test(e.msg));
    try {
      // Five minutes of film for the slow one, which runs past the two of copy4.
      await startOnce(`p2p=0&stream=${slow ? "copy4long" : "copy4"}&event=1&eventS=200&hevc=1`, {}, 40_000);
      await pause(15_000);
      await api("/api/test/nohevc?user=u-host");
      // ~8.4 Mbps a stream: a little faster than it plays.
      if (slow) await api("/api/test/flow?user=u-host&kbps=11000");
      const poppedAt = Date.now();
      const win = hostWin();
      win?.localStorage.setItem("pdt:hevc-failed", "1");
      win?.sessionStorage.setItem("pdt:test:poppedOut", "1");
      win?.location.reload();
      say(`… the host reloaded at ${latest.get("u-host")?.pos.toFixed(1)}s, where it can't play HEVC`);
      let viewerStoppedMs = 0;
      let inStepAt = 0;
      let last = Date.now();
      // When the host first drove the room, and when its stream slowed and
      // came back.
      let droveAt = 0;
      let slowedAt = 0;
      let backAt = 0;
      while (Date.now() - poppedAt < (slow ? 120_000 : 40_000)) {
        await pause(200);
        const now = Date.now();
        if (slow && !droveAt && after("u-host", poppedAt, /^caught up with the room, driving it from here$/).length > 0) {
          droveAt = now;
          slowedAt = now;
          await api("/api/test/flow?user=u-host&kbps=500");
          say(`… the host drove the room ${((now - poppedAt) / 1000).toFixed(1)}s after it reloaded; its stream slowed to 0.5 Mbps`);
        }
        // Back to a speed it catches up at once it has run dry, or 50 s on.
        const dryAt = slowedAt ? after("u-host", slowedAt, /^ran dry|^host's picture not ready/)[0]?.t ?? 0 : 0;
        if (slow && slowedAt && !backAt && ((dryAt && now - dryAt > 2_000) || now - slowedAt > 50_000)) {
          backAt = now;
          await api("/api/test/flow?user=u-host&kbps=16000");
          say(`… and back to 16 Mbps ${((now - slowedAt) / 1000).toFixed(1)}s on${dryAt ? ", the host having run dry" : ""}`);
        }
        const h = latest.get("u-host");
        const v = latest.get("u-viewer");
        if (v && (v.paused || v.ready < 3)) viewerStoppedMs += now - last;
        last = now;
        const reloaded = after("u-host", poppedAt, /^starting session$/).length > 0;
        if (!inStepAt && reloaded && h && v && !h.paused && h.ready >= 3 && Math.abs(h.pos - v.pos) < 1) inStepAt = now;
      }
      const own = after("u-host", poppedAt, /^starting a stream for these tracks$/).map((e) => String(e.data.variant));
      const said = after("u-host", poppedAt, /taking over a room|caught up with the room|catching up|driving it from|picture not ready/).map((e) => e.msg);
      say(`    ${said.join(" → ") || "—"}`);
      say(`${own.length > 0 ? "PASS" : "FAIL"} the host is back on a stream of its own (${own.join(", ") || "the room's"})`);
      say(`${viewerStoppedMs < 1500 ? "PASS" : "FAIL"} the viewer played on (stopped ${(viewerStoppedMs / 1000).toFixed(1)}s in all)`);
      const held = after("u-viewer", poppedAt, /^holding for the room$/);
      say(`${held.length === 0 ? "PASS" : "FAIL"} and never held for the host's new stream (${held.length})`);
      say(`${inStepAt && inStepAt - poppedAt < 20_000 ? "PASS" : "FAIL"} the host was back, playing in step, ${inStepAt ? `${((inStepAt - poppedAt) / 1000).toFixed(1)}s after it reloaded` : "never"}`);
      say(`${said.some((m) => /caught up with the room, driving it from here/.test(m)) ? "PASS" : "FAIL"} the host drives the room again once in step`);
      if (slow) {
        const again = after("u-host", droveAt || poppedAt, /^ran dry soon after catching up with the room/);
        const droveAgain = after("u-host", (again[0]?.t ?? Infinity), /^caught up with the room, driving it from here$/);
        const waits = after("u-host", poppedAt, /^host.s picture not ready/);
        say(`${again.length > 0 ? "PASS" : "FAIL"} run dry on the slow stream, it caught up again rather than the room waiting (${again.length})`);
        say(`${droveAgain.length > 0 ? "PASS" : "FAIL"} and drove the room again once in step (${droveAgain.length})`);
        say(`    the host told the room to wait ${waits.length} times`);
      }
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`${Math.abs(h.pos - v.pos) < 1 && !h.paused && !v.paused ? "PASS" : "FAIL"} and they play on together (${(h.pos - v.pos).toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      try {
        hostWin()?.sessionStorage.removeItem("pdt:test:poppedOut");
        hostWin()?.localStorage.removeItem("pdt:hevc-failed");
      } catch { /* gone */ }
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host handing the room to a viewer who has only just joined, as
   * blah0391 handed monkey26 the room on 16 October. Its picture wasn't moving
   * yet — still loading, and waiting a little past the room for it — so it was
   * never told to play, its first heartbeat said it was paused, and the room
   * paused for everybody, 12.6 and 15 seconds until somebody pressed play.
   * Now the one who handed it over plays on, skipping nothing, and the new
   * host comes in once its picture is in step with the room.
   */
  async function runHandToJoiner() {
    setRunning(true);
    const out: string[] = ["— the host handing the room to a viewer who has just joined —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    let sampler = 0;
    try {
      latest.clear();
      events.clear();
      await api("/api/test/reset?p2p=0&stream=copy4&event=1&eventS=120");
      await api("/api/test/flow?user=u-viewer&kbps=6000");
      viewerQuery = "&latejoin&followRole";
      hostQuery = "&followRole";
      setHostOn(false);
      setFrames(nextFrames(currentGen));
      setHostOn(true);
      await waitFor(() => { const h = latest.get("u-host"); return !!h && !h.paused && h.pos > 20; }, 90_000, "the host 20s in");
      (viewerFrame.current?.contentWindow as Window | null | undefined)?.postMessage({ kind: "press", press: ["Join"] }, "*");
      await waitFor(() => events.get("u-viewer")?.some((e) => e.tag === "HLS" && e.msg === "manifest parsed"), 30_000, "the joiner's stream");
      const samples: Sample[] = [];
      sampler = window.setInterval(() => {
        const host = latest.get("u-host");
        const viewer = latest.get("u-viewer");
        if (host && viewer) samples.push({ t: Date.now(), host, viewer });
      }, 100);
      hostFixture()?.actions?.sendPromoteHost("u-viewer");
      const handedAt = Date.now();
      const v0 = latest.get("u-viewer");
      say(`… handed over at ${latest.get("u-host")!.pos.toFixed(1)}s, the joiner ${v0 && !v0.paused ? "playing" : "not playing yet"} (readyState ${v0?.ready ?? "?"})`);
      await pause(25_000);
      window.clearInterval(sampler);
      const joiner = events.get("u-viewer") ?? [];
      const promoted = joiner.some((e) => e.t >= handedAt && /promoted to host/.test(e.msg));
      const newHostPlayedAt = joiner.find((e) => e.t >= handedAt && e.tag === "Video" && e.msg === "playing")?.t;
      const after = samples.filter((x) => x.t >= handedAt);
      // "host" is the player who hosted until now.
      const pausedMs = after.filter((x) => x.host.paused).length * 100;
      const jumped = after.filter((x, i) => i > 0 && x.host.pos - after[i - 1].host.pos > 1.5).length;
      const back = after.filter((x, i) => i > 0 && after[i - 1].host.pos - x.host.pos > 0.5).length;
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`${promoted ? "PASS" : "FAIL"} the joiner was made host`);
      say(`${pausedMs <= 500 ? "PASS" : "FAIL"} the one who handed it over plays on (paused ${pausedMs} ms)`);
      say(`${jumped === 0 && back === 0 ? "PASS" : "FAIL"} and skips nothing and sees nothing twice (${jumped} jump(s) on, ${back} back)`);
      say(`${newHostPlayedAt && newHostPlayedAt - handedAt < 15_000 ? "PASS" : "FAIL"} the new host plays within fifteen seconds (${newHostPlayedAt ? `${((newHostPlayedAt - handedAt) / 1000).toFixed(1)}s` : "never"})`);
      say(`${Math.abs(v.pos - h.pos) < 1 && !v.paused && !h.paused ? "PASS" : "FAIL"} together 25 seconds on (${(v.pos - h.pos).toFixed(2)}s apart${v.paused ? ", the new host paused" : ""}${h.paused ? ", the old host paused" : ""})`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      window.clearInterval(sampler);
      viewerQuery = "";
      hostQuery = "";
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host skipping again and again in a copied film, faster than each new
   * stream comes. On 16 October blah0391 skipped twelve times in sixteen
   * seconds: each stream a newer skip had replaced still told the room where
   * it began, the room went there — to 46:35 after a skip to 20:02 — and ended
   * ten minutes from where the last skip went, with monkey26 stuck for half a
   * minute. Now everybody plays from where the last skip went.
   */
  async function runSkipBurst() {
    setRunning(true);
    const out: string[] = ["— the host skipping faster than a copy's new streams come —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    let sampler = 0;
    try {
      // A new stream's playlist a second and a half in coming, as Plex starting a copy.
      await startOnce("p2p=0&stream=copy4&event=1&eventS=20&manifestMs=1500", {}, 60_000);
      await pause(3_000);
      const samples: Sample[] = [];
      sampler = window.setInterval(() => {
        const host = latest.get("u-host");
        const viewer = latest.get("u-viewer");
        if (host && viewer) samples.push({ t: Date.now(), host, viewer });
      }, 100);
      const began = Date.now();
      const press = (key: string, n: number) => { for (let i = 0; i < n; i++) hostKey(key); };
      // On, further on while that loads, and all the way back while that does.
      press("ArrowRight", 4);
      await pause(1_000);
      press("ArrowRight", 8);
      await pause(1_300);
      press("ArrowLeft", 12);
      await pause(1_500);
      const seeks = (events.get("u-host") ?? []).filter((e) => e.t >= began && e.tag === "Seek" && e.msg === "host seek");
      const last = Number(seeks[seeks.length - 1]?.data.targetS);
      const lastAt = seeks[seeks.length - 1]?.t ?? began;
      say(`… skipped ${seeks.length} times: ${seeks.map((e) => Number(e.data.targetS).toFixed(0)).join("s → ")}s`);
      const there = (r: Report | undefined) => !!r && !r.paused && r.pos > last - 3 && r.pos < last + 15;
      await waitFor(() => there(latest.get("u-host")) && there(latest.get("u-viewer")), 40_000, "both to play from where the last skip went");
      const thereAt = Date.now();
      await pause(4_000);
      window.clearInterval(sampler);
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      // Playing somewhere an earlier skip went, after the last one.
      const elsewhere = samples.filter((x) => x.t > lastAt &&
        ((!x.host.paused && x.host.pos > last + 20) || (!x.viewer.paused && x.viewer.pos > last + 20))).length;
      const roomWrong = (events.get("u-host") ?? []).filter((e) => e.t >= began && /the room's clock is before this stream begins/.test(e.msg)).length;
      const stuck = (events.get("u-viewer") ?? []).filter((e) => e.t >= began && /seek stalled with no progress/.test(e.msg)).length;
      const replaced = (events.get("u-host") ?? []).filter((e) => e.t >= began && /a newer skip replaces this stream/.test(e.msg)).length;
      say(`${thereAt - lastAt < 12_000 ? "PASS" : "FAIL"} both play from where the last skip went, ${((thereAt - lastAt) / 1000).toFixed(1)}s after it (host at ${h.pos.toFixed(1)}s, viewer at ${v.pos.toFixed(1)}s)`);
      say(`${elsewhere === 0 && roomWrong === 0 ? "PASS" : "FAIL"} and nobody plays where an earlier skip went (${elsewhere} samples; the room's clock past the host's stream ${roomWrong} time(s))`);
      say(`${Math.abs(v.pos - h.pos) < 1 ? "PASS" : "FAIL"} together (${Math.abs(v.pos - h.pos).toFixed(2)}s apart)`);
      say(`${stuck === 0 ? "PASS" : "FAIL"} and the viewer never stuck on the way (${stuck})`);
      say(`streams replaced before they were announced: ${replaced}`);
    } catch (err) {
      const h = latest.get("u-host");
      const v = latest.get("u-viewer");
      say(`FAIL ${String(err)} (host at ${h?.pos.toFixed(1)}s ${h?.paused ? "paused" : "playing"}, viewer at ${v?.pos.toFixed(1)}s ${v?.paused ? "paused" : "playing"})`);
    } finally {
      window.clearInterval(sampler);
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * One player popping the activity out mid-film, which Discord does by
   * reloading it. On 12 October the host's pop-out stopped the whole room for
   * 21 seconds: it came back as host, loaded the film from its start, told
   * the room it was at 0:00 and had it wait there. Now nobody else stops, and
   * the one that popped out is back in step within a few seconds.
   */
  /**
   * `slowBack`: the popped player's first segments back come nine seconds
   * late, as monkey26's did on 12 October — the room is past where it landed
   * before it has anything to show there.
   */
  async function runPopOut(who: "host" | "viewer", comeBack: "fast" | "slow" | "long" = "fast") {
    setRunning(true);
    const slowBack = comeBack !== "fast";
    const out: string[] = [`— the ${who} popping the activity out mid-film${comeBack === "slow" ? ", its stream slow to come back" : comeBack === "long" ? ", its stream away for 35 seconds" : ""} —`];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    const popped = who === "host" ? "u-host" : "u-viewer";
    const other = who === "host" ? "u-viewer" : "u-host";
    try {
      // Without peers when slow, or the other player would hand it what the
      // server holds back.
      await startOnce(`p2p=${slowBack ? 0 : 1}&stream=copy4&event=1&eventS=200&previews=1`, {}, 40_000);
      await pause(15_000);
      const before = latest.get(popped)!.pos;
      // "long": longer than the room's clock used to run on without the
      // host's word — thirty seconds — as blah0391's catch-up did on 13
      // October, when the room went half a minute back.
      if (slowBack) await api(`/api/test/stall?user=${popped}&ms=${comeBack === "long" ? 35_000 : 9000}`);
      const poppedAt = Date.now();
      if (who === "host") {
        const win = hostFrame.current?.contentWindow as (Window & typeof globalThis) | null | undefined;
        win?.sessionStorage.setItem("pdt:test:poppedOut", "1");
        win?.location.reload();
      } else {
        const frame = viewerFrame.current;
        if (frame) frame.src = frame.src;
      }
      say(`… ${who} reloaded at ${before.toFixed(1)}s`);
      let otherStoppedMs = 0;
      let inStepAt = 0;
      let last = Date.now();
      let otherLastPos = latest.get(other)?.pos ?? 0;
      let otherBack = 0;
      while (Date.now() - poppedAt < (comeBack === "long" ? 75_000 : slowBack ? 40_000 : 30_000)) {
        await pause(200);
        const now = Date.now();
        const o = latest.get(other);
        const p = latest.get(popped);
        if (o && (o.paused || o.ready < 3)) otherStoppedMs += now - last;
        last = now;
        if (o) {
          if (o.pos < otherLastPos - 0.3) otherBack = Math.max(otherBack, otherLastPos - o.pos);
          otherLastPos = o.pos;
        }
        // Only once the reloaded page has a stream of its own: the old one goes on
        // reporting for a moment after the reload is asked for.
        const reloaded = (events.get(popped) ?? []).some((e) => e.t > poppedAt && e.tag === "HLS" && e.msg === "starting session");
        if (!inStepAt && reloaded && p && o && !p.paused && p.ready >= 3 && Math.abs(p.pos - o.pos) < 1) inStepAt = now;
      }
      const o = latest.get(other)!;
      const p = latest.get(popped)!;
      const said = (events.get(popped) ?? []).filter((e) => e.t >= poppedAt && /taking over a room|caught up with the room|catching up|driving it from|ahead of the room, waiting|start of the next segment/.test(e.msg)).map((e) => e.msg);
      say(`    ${said.join(" → ") || "—"}`);
      // Stops once it is playing again, on the reloaded page.
      const back = (events.get(popped) ?? []).filter((e) => e.t >= poppedAt);
      const startedAt = back.find((e) => e.tag === "HLS" && e.msg === "starting session")?.t ?? Infinity;
      const playingAt = back.find((e) => e.t >= startedAt && e.tag === "Video" && e.msg === "playing")?.t ?? Infinity;
      // Not the moment a seek of its own takes: that is a jump, not a stop.
      const stopsBack = back.filter((e) => e.t > playingAt && e.tag === "Video" && /buffer starved/.test(e.msg) &&
        e.data.paused === false && e.data.seeking !== true);
      say(`${otherStoppedMs < 1500 ? "PASS" : "FAIL"} the ${who === "host" ? "viewer" : "host"} played on (stopped ${(otherStoppedMs / 1000).toFixed(1)}s in all)`);
      say(`${otherBack === 0 ? "PASS" : "FAIL"} and was never sent back${otherBack ? ` (${otherBack.toFixed(1)}s)` : ""}`);
      const backWithinMs = comeBack === "long" ? 70_000 : slowBack ? 30_000 : 15_000;
      say(`${inStepAt && inStepAt - poppedAt < backWithinMs ? "PASS" : "FAIL"} the ${who} was back, playing in step, ${inStepAt ? `${((inStepAt - poppedAt) / 1000).toFixed(1)}s after it reloaded` : "never"}`);
      say(`${Math.abs(p.pos - o.pos) < 1 && !p.paused && !o.paused ? "PASS" : "FAIL"} and they play on together (${(p.pos - o.pos).toFixed(2)}s apart)`);
      say(`${stopsBack.length <= 1 ? "PASS" : "FAIL"} the ${who}, playing again, stops no more than once (${stopsBack.length})`);
      if (who === "host") {
        say(`${said.some((m) => /caught up with the room, driving it from here/.test(m)) ? "PASS" : "FAIL"} the host drives the room again once in step`);
        say(`${said.some((m) => /not caught up with the room in time/.test(m)) ? "FAIL" : "PASS"} and never from out of step`);
        // The viewer was the host while it was away, and its seek bar's frames
        // went with that on 12 October: none were left, and none came again.
        const viewerAgain = (events.get(other) ?? []).filter((e) => e.t >= poppedAt && e.tag === "Preview" && e.msg === "transfer accepted");
        say(`${viewerAgain.length === 0 ? "PASS" : "FAIL"} the viewer kept its preview frames through its turn as host (${viewerAgain.length} fetched again)`);
      }
      if (who === "host" && comeBack === "fast") {
        // Back, it no longer drives the stream — the viewer went on driving
        // it — and a rewind into what it has held the whole room on 13
        // October, twice. It goes straight on, as the driver's own does.
        await pause(5_000);
        const from = latest.get("u-host")!.pos;
        const rewoundAt = Date.now();
        hostKey("ArrowLeft");
        await waitFor(() => { const h = latest.get("u-host"); return !!h && h.pos < from - 5 && !h.paused && h.ready >= 3; }, 15_000, "the host's rewind");
        await pause(3_000);
        const held = ["u-host", "u-viewer"].flatMap((u) => (events.get(u) ?? []).filter((e) => e.t >= rewoundAt && /holding for the room/.test(e.msg)));
        say(`${held.length === 0 ? "PASS" : "FAIL"} back and not driving the stream, its rewind into what it holds doesn't hold the room (${held.length})`);
        const h = latest.get("u-host")!;
        const v = latest.get("u-viewer")!;
        say(`${Math.abs(h.pos - v.pos) < 1 && !h.paused && !v.paused ? "PASS" : "FAIL"} and the viewer goes back with it (${(h.pos - v.pos).toFixed(2)}s apart)`);
      }
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      try { (hostFrame.current?.contentWindow as (Window & typeof globalThis) | null | undefined)?.sessionStorage.removeItem("pdt:test:poppedOut"); } catch { /* gone */ }
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host, alone in the room, popping the activity out. On 12 October the
   * transcode was killed as its socket closed — it was the last one out — and
   * the page that came back found nothing playing. Now the room is held for it
   * (sync.ts, holdEmptyRoom), with its clock where it stopped, and the page
   * that comes back goes on with the same stream, from there.
   */
  async function runAlonePopOut() {
    setRunning(true);
    const out: string[] = ["— the host popping the activity out with nobody else in the room —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      latest.clear();
      events.clear();
      await api("/api/test/reset?p2p=0&stream=copy4&event=1&eventS=200&previews=1");
      // The viewer's frame waits to be told to join, and never is.
      viewerQuery = "&latejoin";
      setHostOn(false);
      setFrames(nextFrames(currentGen));
      setHostOn(true);
      await waitFor(() => { const h = latest.get("u-host"); return !!h && !h.paused && h.pos > 20; }, 90_000, "the host 20s in");
      // Some way into the preview frames' passes as well.
      await pause(8_000);
      const before = latest.get("u-host")!.pos;
      const poppedAt = Date.now();
      const win = hostFrame.current?.contentWindow as (Window & typeof globalThis) | null | undefined;
      win?.sessionStorage.setItem("pdt:test:poppedOut", "1");
      win?.location.reload();
      say(`… the host reloaded at ${before.toFixed(1)}s, alone`);
      let backAt = 0;
      let backPos = NaN;
      while (Date.now() - poppedAt < 30_000) {
        await pause(200);
        const reloaded = (events.get("u-host") ?? []).some((e) => e.t > poppedAt && e.tag === "HLS" && e.msg === "starting session");
        const h = latest.get("u-host");
        if (!backAt && reloaded && h && !h.paused && h.ready >= 3) { backAt = Date.now(); backPos = h.pos; }
        if (backAt && Date.now() - backAt > 3_000) break;
      }
      const back = (events.get("u-host") ?? []).filter((e) => e.t >= poppedAt);
      const started = back.find((e) => e.tag === "HLS" && e.msg === "starting session");
      const landed = back.find((e) => /landing on the room clock/.test(e.msg));
      const afterBack = back.filter((e) => backAt && e.t > backAt);
      const stops = afterBack.filter((e) => e.tag === "Video" && /buffer starved/.test(e.msg) && e.data.paused === false && e.data.seeking !== true);
      say(`    ${landed ? `landed at ${Number(landed.data.toS).toFixed(1)}s` : "no landing"}`);
      // Within a few seconds: the room told the moment its picture is ready,
      // not at its next heartbeat, which kept it waiting five.
      say(`${backAt && backAt - poppedAt < 3_000 ? "PASS" : "FAIL"} the film went on: the host was playing again ${backAt ? `${((backAt - poppedAt) / 1000).toFixed(1)}s after it reloaded` : "never"}`);
      say(`${Number.isFinite(backPos) && Math.abs(backPos - before) < 3 ? "PASS" : "FAIL"} from where it left (${Number.isFinite(backPos) ? backPos.toFixed(1) : "—"}s, left at ${before.toFixed(1)}s)`);
      say(`${started?.data.adopted === true ? "PASS" : "FAIL"} on the stream it left, not a new one (adopted ${String(started?.data.adopted)})`);
      say(`${stops.length === 0 ? "PASS" : "FAIL"} and it plays on without stopping (${stops.length})`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      viewerQuery = "";
      try { (hostFrame.current?.contentWindow as (Window & typeof globalThis) | null | undefined)?.sessionStorage.removeItem("pdt:test:poppedOut"); } catch { /* gone */ }
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

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
    /**
     * Whether the speed the host went by is its first segment's as the engine
     * timed it, from asking for it — what the "segment in" log gives — and
     * not hls.js's, which starts later for a segment fetched in parts: on 11
     * October that read 94 Mbps for a segment that came in at 24, and the
     * film started on it and stalled.
     */
    const engineSpeed = (decided: { data: Record<string, unknown> } | undefined) => {
      const loaded = (events.get("u-host") ?? []).find((e) => e.tag === "Load" && e.msg === "segment in");
      const logged = Number(loaded?.data.Mbps);
      const used = Number(decided?.data.firstMbps);
      say(`${Math.abs(used - logged) <= Math.max(0.3, logged * 0.05) ? "PASS" : "FAIL"} going by the first segment's speed as the engine timed it (${used} against ${logged} Mbps)`);
    };
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
      const snap = hostSaid(/starting on the first segment's keyframe/);
      say(`fast, resumed at 0:43.4, 0.6s before it ends: started ${late.startS.toFixed(1)}s after play, host at ${hostAt.toFixed(2)}s, viewer at ${viewerAt.toFixed(2)}s, ${late.apartMs} ms apart`);
      if (snap) say(`    the host's first segment at ${snap.data.firstMbps} Mbps, so the next in ${snap.data.nextInS}s`);
      say(`${snap && Math.abs(hostAt - 40) < 0.5 && Math.abs(viewerAt - 40) < 0.5 ? "PASS" : "FAIL"} both start on the keyframe the copy begins at, 0:40`);
      say(`${late.startS < covered.startS + 1 ? "PASS" : "FAIL"} as soon as from a point the first segment covers (${late.startS.toFixed(1)}s against ${covered.startS.toFixed(1)}s)`);
      engineSpeed(snap);
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
      const held = hostSaid(/not starting on the first segment's keyframe/);
      say(`slow, resumed at 0:43.4: started ${slowly.startS.toFixed(1)}s after play, host at ${slowHostAt.toFixed(2)}s, viewer at ${slowViewerAt.toFixed(2)}s, ${slowly.apartMs} ms apart`);
      if (held) say(`    the host's first segment at ${held.data.firstMbps} Mbps, so the next in ${held.data.nextInS}s`);
      say(`${held && Math.abs(slowHostAt - 43.4) < 0.5 && Math.abs(slowViewerAt - 43.4) < 0.5 ? "PASS" : "FAIL"} the next segment can't be in in time, so both wait for it and start where they were asked`);
      engineSpeed(held);
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
    const SAID = /Host is switching (?:audio|subtitles|quality)…|Switching (?:audio|subtitles|quality)…|(?:Co-host|Host) is seeking…|Host paused the video|Loading…|Buffering…|Catching up to host · \d+ s|Host paused · Catching up to host · \d+%|Stream interrupted — Reconnecting\.\.\.|Stream lost|Reconnecting to the watch party…|Connection lost|Playback error[^\n]*/g;
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

  /**
   * A subtitle inside the file, drawn while it is still being read — the test
   * server reads it from the start at three film seconds a second, and around
   * anywhere a player is a moment after it asks, as the bot does (see
   * subtitleRead in sync-room-server.ts). On each player, sample by sample:
   * the line for wherever the picture is, from the start, after a skip to
   * somewhere nothing has been read, and nothing in the quiet between lines;
   * "Loading subtitles…" only where its lines haven't come, and briefly.
   */
  async function runSubtitleReads() {
    setRunning(true);
    const out: string[] = ["— a subtitle Plex is still reading —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    const press = (who: "host" | "viewer", labels: string[]) =>
      (who === "host" ? hostFrame : viewerFrame).current?.contentWindow?.postMessage({ kind: "press", press: labels }, "*");
    /** Each player's picture against the lines — one every three seconds, two
     *  long — for `ms`, with "Loading subtitles…" allowed up for `loadingMs`. */
    const watch = async (what: string, ms: number, loadingMs: number) => {
      const sampler = sampleBoth();
      await pause(ms);
      sampler.stop();
      for (const who of ["host", "viewer"] as const) {
        let shown = 0;
        let between = 0;
        let loading = 0;
        const missing: string[] = [];
        const extra: string[] = [];
        let last = 0;
        for (const x of sampler.samples) {
          const r = x[who];
          const dt = last ? x.t - last : 0;
          last = x.t;
          if (r.paused || r.ready < 3 || r.loading) continue;
          const waiting = r.text.includes("Loading subtitles…");
          if (waiting) loading += dt;
          const n = Math.floor(r.pos / 3);
          const into = r.pos - n * 3;
          if (into >= 0.35 && into <= 1.75) {
            if (new RegExp(`\\bLine ${n + 1}\\b`).test(r.text)) shown++;
            else if (!waiting) missing.push(`${r.pos.toFixed(1)}s`);
          } else if (into >= 2.25 && into <= 2.75) {
            between++;
            const up = r.text.match(/\bLine \d+\b/);
            if (up) extra.push(`${up[0]} at ${r.pos.toFixed(1)}s`);
          }
        }
        const ok = shown > 0 && missing.length === 0 && extra.length === 0 && loading <= loadingMs;
        say(`${ok ? "PASS" : "FAIL"} ${what}: the ${who} showed the right line ${shown} times, nothing between lines ${between - extra.length} of ${between}` +
          `, "Loading subtitles…" for ${(loading / 1000).toFixed(1)}s (up to ${(loadingMs / 1000).toFixed(1)}s allowed)` +
          (missing.length ? ` — no line at ${missing.slice(0, 8).join(", ")}` : "") +
          (extra.length ? ` — up between lines: ${extra.slice(0, 5).join(", ")}` : ""));
      }
    };
    try {
      // From no subtitle, whatever the last run left chosen: the host's
      // player keeps its choices where this page can reach them.
      localStorage.removeItem("pdt:titleTracks:v1");
      localStorage.setItem("pdt:subtitlePref", JSON.stringify({ off: true }));
      // What is checked is the page's text, which the subtitle layer updates
      // once a frame: kept going when the browser isn't drawing this one.
      await startOnce("p2p=0&stream=copy4&event=1&subPace=3", {}, 0, "&timerFrames");
      await pause(2_000);
      press("host", ["Audio & Subtitles", "Subtitles", "English (in the file)"]);
      await pause(1_500);
      await watch("from the start, as it is read", 9_000, 0);
      for (let i = 0; i < 5; i++) hostKey("ArrowRight");
      await watch("after the host skips fifty seconds ahead, past what has been read", 16_000, 1_500);
      press("host", ["Audio & Subtitles", "Subtitles", "None"]);
      await pause(1_500);
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

  /** A download the test server answered — see /api/test/served. */
  type Served = { user: string; seg: string; at: number; heldMs: number; part?: string; bytes?: number; ms?: number; sent?: number; cut?: boolean; askedAt?: number };

  /**
   * A viewer joining while the host is well ahead, everybody's downloads
   * sharing one upload as they share the bot's. On 13 October each join, and
   * each return from a pop-out, had a third to half of the bot's upload beside
   * a player filling its buffer up to two minutes ahead at full speed, and took
   * 12 to 34 seconds to be back in the film. The host eases off now while the
   * viewer is short of picture.
   */
  async function runJoinWhileAhead() {
    setRunning(true);
    const out: string[] = ["— a viewer joining while the host is well ahead, on one shared upload —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      latest.clear();
      events.clear();
      await api("/api/test/reset?p2p=0&stream=copy4long&event=1&eventS=300");
      // Twice the film's own speed, for everybody together.
      await api("/api/test/upload?kbps=16000");
      viewerQuery = "&latejoin";
      setHostOn(false);
      setFrames(nextFrames(currentGen));
      setHostOn(true);
      /** How far past its picture the host has had its segments, seconds. */
      const hostAheadS = async () => {
        const h = latest.get("u-host");
        if (!h) return 0;
        const got = new Set((await api("/api/test/served") as Served[]).filter((s) => s.user === "u-host" && !s.cut).map((s) => s.seg));
        let i = Math.floor(h.pos / 4);
        while (got.has(`seg${String(i).padStart(3, "0")}.ts`)) i++;
        return i * 4 - h.pos;
      };
      // As players are, a while into a film: well over a minute ahead.
      for (const end = Date.now() + 180_000; ; await pause(1000)) {
        const h = latest.get("u-host");
        if (h && !h.paused && h.pos > 20 && await hostAheadS() >= 80) break;
        if (Date.now() > end) throw new Error("timed out waiting for the host to be 80s ahead");
      }
      const joinedAt = Date.now();
      say(`… the host ${(await hostAheadS()).toFixed(0)}s ahead at ${latest.get("u-host")!.pos.toFixed(0)}s: the viewer joins`);
      (viewerFrame.current?.contentWindow as Window | null | undefined)?.postMessage({ kind: "press", press: ["Join"] }, "*");
      const firstAt = await waitFor(() => firstPlay("u-viewer"), 60_000, "the viewer to play");
      // Until the viewer has picture enough again, or a minute.
      const enoughAt = await waitFor(() => (events.get("u-viewer") ?? []).find((e) => e.t > joinedAt && /no longer short of picture/.test(e.msg))?.t, 60_000, "the viewer to have picture enough")
        .catch(() => null);
      await pause(5_000);
      const served = await api("/api/test/served") as Served[];
      const viewer = (events.get("u-viewer") ?? []).filter((e) => e.t >= joinedAt);
      const host = (events.get("u-host") ?? []).filter((e) => e.t >= joinedAt);
      const easedAt = host.find((e) => /easing off the bot/.test(e.msg))?.t ?? null;
      // What each had of the upload until the viewer's first frame: each
      // download's bytes, spread over its time.
      const bytesOf = (user: string, from: number, to: number) => served.filter((s) => s.user === user && s.askedAt !== undefined).reduce((sum, s) => {
        const start = s.askedAt! + s.heldMs;
        const overlap = Math.max(0, Math.min(s.at, to) - Math.max(start, from));
        return sum + (s.at > start ? ((s.sent ?? 0) * overlap) / (s.at - start) : 0);
      }, 0);
      const backAt = host.find((e) => /back to downloading at full speed/.test(e.msg))?.t ?? null;
      const shareOf = (from: number, to: number) => {
        const v = bytesOf("u-viewer", from, to);
        return v / Math.max(1, v + bytesOf("u-host", from, to));
      };
      const firstShare = shareOf(joinedAt, firstAt);
      // While the host eased off, once what it had under way was in.
      const easedFrom = (easedAt ?? joinedAt) + 3000;
      const easedTo = Math.min(enoughAt ?? Infinity, backAt ?? Infinity, Date.now());
      const easedShare = easedTo > easedFrom ? shareOf(easedFrom, easedTo) : NaN;
      say(`viewer's first frame ${((firstAt - joinedAt) / 1000).toFixed(1)}s after joining, with ${(firstShare * 100).toFixed(0)}% of the upload until then; picture enough ${enoughAt ? `${((enoughAt - joinedAt) / 1000).toFixed(1)}s after` : "never said"}`);
      say(`${easedAt ? "PASS" : "FAIL"} the host eases off the bot while the viewer is short of picture`);
      say(`${easedShare >= 0.8 ? "PASS" : "FAIL"} and the viewer has the upload meanwhile (${Number.isFinite(easedShare) ? (easedShare * 100).toFixed(0) : "—"}%, ${(firstShare * 100).toFixed(0)}% until its first frame)`);
      const stops = viewer.filter((e) => e.t > firstAt && e.tag === "Video" && /buffer starved/.test(e.msg) && e.data.paused === false && e.data.seeking !== true);
      const past = viewer.filter((e) => /going past it/.test(e.msg));
      const jumps = viewer.filter((e) => /heartbeat drift correction/.test(e.msg));
      say(`${past.length === 0 && jumps.length === 0 ? "PASS" : "FAIL"} the viewer is never jumped ahead (${past.length} past the room, ${jumps.length} to it)`);
      say(`${stops.length <= 1 ? "PASS" : "FAIL"} and stops no more than once after it starts (${stops.length})`);
      const hostStops = host.filter((e) => e.tag === "Video" && /buffer starved/.test(e.msg) && e.data.paused === false && e.data.seeking !== true);
      say(`${hostStops.length === 0 ? "PASS" : "FAIL"} the host never stops (${hostStops.length})`);
      // Once the viewer has picture enough — or its own is down to what it keeps whatever happens.
      const backInHand = Number(host.find((e) => /back to downloading at full speed/.test(e.msg))?.data.inHandS ?? NaN);
      say(`${easedAt && backAt && ((enoughAt && backAt >= enoughAt - 1000) || backInHand < 21) ? "PASS" : "FAIL"} and goes back to full speed once the viewer has picture enough, or its own needs it (${backAt ? `${((backAt - joinedAt) / 1000).toFixed(1)}s after the join, ${backInHand.toFixed(0)}s in hand` : "never"})`);
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`${Math.abs(v.pos - h.pos) < 1 && !v.paused && !h.paused ? "PASS" : "FAIL"} together at the end (${(v.pos - h.pos).toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      viewerQuery = "";
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host popping the activity out, the browser keeping what the bot sends
   * for five minutes, as it does: the page that comes back finds there what the
   * page before had, rather than having it all again from the bot. On 13
   * October each page back from a pop-out asked for its first segment in eight
   * parts where the page before had fetched it in four, and had all 26 to 28
   * MB of it again from the bot before it could show anything.
   */
  /**
   * And where the page back lands: just past the room, when what it plays
   * from there is in the browser's cache. On 14 October three pages back had
   * their next 30 to 40 seconds there and landed 3, 7 and 11 seconds past the
   * room all the same, by the bot's speed, and waited that long for it.
   */
  /**
   * `browserLetGo`: the browser's own cache keeps none of what the bot sends,
   * as under a 20 to 38 Mbps film it often had let it go by the time a page
   * came back — and what the page before kept for it (lib/segmentKeep) is
   * all there is.
   */
  async function runPopOutCache(who: "host" | "viewer" = "host", browserLetGo = false) {
    setRunning(true);
    const out: string[] = [browserLetGo
      ? `— the ${who} popping out, the browser's cache keeping nothing of what the bot sent —`
      : `— the ${who} popping out, with what the bot sent kept by the browser —`];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    const popped = who === "host" ? "u-host" : "u-viewer";
    const other = who === "host" ? "u-viewer" : "u-host";
    try {
      await startOnce(`p2p=0&stream=copy4&event=1&eventS=200&cache=${browserLetGo ? "none" : "1"}`, {}, 40_000);
      await pause(15_000);
      // Every segment it had whole before it popped out: all of one split's parts.
      const before = (await api("/api/test/served") as Served[]).filter((s) => s.user === popped && !s.cut);
      const parts = new Map<string, Map<string, Set<string>>>();
      const whole = new Set<string>();
      for (const s of before) {
        if (!s.part) { whole.add(s.seg); continue; }
        const [i, n] = s.part.split("/");
        if (n === undefined) continue;
        const splits = parts.get(s.seg) ?? new Map<string, Set<string>>();
        const got = splits.get(n) ?? new Set<string>();
        got.add(i);
        splits.set(n, got);
        parts.set(s.seg, splits);
        if (got.size === Number(n)) whole.add(s.seg);
      }
      const poppedAt = Date.now();
      if (who === "host") {
        const win = hostFrame.current?.contentWindow as (Window & typeof globalThis) | null | undefined;
        win?.sessionStorage.setItem("pdt:test:poppedOut", "1");
        win?.location.reload();
      } else {
        const frame = viewerFrame.current;
        if (frame) frame.src = frame.src;
      }
      say(`… the ${who} reloaded at ${latest.get(popped)?.pos.toFixed(1)}s, having had ${whole.size} segments whole`);
      await waitFor(() => {
        const p = latest.get(popped);
        const o = latest.get(other);
        const reloaded = (events.get(popped) ?? []).some((e) => e.t > poppedAt && e.tag === "HLS" && e.msg === "starting session");
        return reloaded && p && o && !p.paused && p.ready >= 3 && Math.abs(p.pos - o.pos) < 1;
      }, 30_000, `the ${who} back in step`);
      const backS = (Date.now() - poppedAt) / 1000;
      await pause(3_000);
      const again = (await api("/api/test/served") as Served[])
        .filter((s) => s.user === popped && (s.askedAt ?? s.at) > poppedAt && whole.has(s.seg));
      const againMB = again.reduce((sum, s) => sum + (s.sent ?? 0), 0) / 1e6;
      const back = (events.get(popped) ?? []).filter((e) => e.t > poppedAt);
      const firstSegs = back.filter((e) => e.tag === "Load" && e.msg === "segment in");
      say(`    back in step ${backS.toFixed(1)}s after the reload; its first segments ${firstSegs.map((e) => `${e.data.tookS}s${e.data.cache ? " (cache)" : ""}`).join(", ") || "—"}`);
      say(`${again.length === 0 ? "PASS" : "FAIL"} the page back had nothing again from the bot that the page before had whole (${againMB.toFixed(1)} MB, ${new Set(again.map((s) => s.seg)).size} segment(s))`);
      // Where it landed, and how long it waited there with its picture in.
      const landed = back.filter((e) => e.tag === "Sync" && /^landing (just past|further past|on the room clock|at the start of the next)/.test(e.msg)).at(-1);
      const pastS = landed ? Number(landed.data.toS) - Number(landed.data.roomPosS ?? landed.data.toS) : null;
      const waitedMs = back.filter((e) => e.tag === "Sync" && e.msg === "done waiting for the room").reduce((sum, e) => sum + Number(e.data.waitedMs ?? 0), 0);
      say(`${landed && /just past the room/.test(landed.msg) && pastS !== null && pastS < 2 ? "PASS" : "FAIL"} it lands just past the room, what it plays being in the browser's cache (${landed ? `${landed.msg}, ${pastS?.toFixed(1)}s past` : "no landing said"})`);
      say(`${waitedMs < 3000 ? "PASS" : "FAIL"} and waits there no more than a moment for it (${(waitedMs / 1000).toFixed(1)}s)`);
      const p = latest.get(popped)!;
      const o = latest.get(other)!;
      say(`${Math.abs(p.pos - o.pos) < 1 && !p.paused && !o.paused ? "PASS" : "FAIL"} and the two play on together (${(p.pos - o.pos).toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      try { (hostFrame.current?.contentWindow as (Window & typeof globalThis) | null | undefined)?.sessionStorage.removeItem("pdt:test:poppedOut"); } catch { /* gone */ }
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * A viewer on a stream of its own — its own audio, its own quality — popping
   * the activity out. The page back used to be put on the host's stream, its
   * audio and quality gone, and the one it had been on ran on with nobody on
   * it until the room ended. Now the page back takes up its own stream again,
   * the transcode it was driving, and asks for nothing else.
   */
  async function runPopOutOwnTracks() {
    setRunning(true);
    const out: string[] = ["— a viewer on its own audio and quality popping the activity out —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    const press = (labels: string[]) => viewerFrame.current?.contentWindow?.postMessage({ kind: "press", press: labels }, "*");
    const after = (t: number, msg: RegExp) => (events.get("u-viewer") ?? []).filter((e) => e.t > t && msg.test(e.msg));
    const inStep = () => {
      const h = latest.get("u-host");
      const v = latest.get("u-viewer");
      return !!h && !!v && !h.paused && !v.paused && v.ready >= 3 && Math.abs(h.pos - v.pos) < 1;
    };
    try {
      // A list long enough to outlast the check: forty seconds of it, and the
      // host stops at its end whatever the viewer does.
      await startOnce("p2p=0&stream=copy4&event=1&eventS=200", {}, 40_000);
      await pause(3_000);
      const choseAt = Date.now();
      const started = (t: number) => after(t, /^starting a stream for these tracks$/);
      press(["Audio & Subtitles", "Audio", "Français (AAC Stereo)"]);
      await waitFor(() => started(choseAt).length > 0 && inStep(), 45_000, "the viewer on its own audio");
      await pause(2_000);
      const qualityAt = Date.now();
      press(["Audio & Subtitles", "Quality", "Up to 8 Mbps"]);
      await waitFor(() => started(qualityAt).some((e) => /@8000$/.test(String(e.data.variant))) && inStep(),
        45_000, "the viewer on its own audio at its own quality");
      const own = String(started(qualityAt).at(-1)?.data.variant);
      // A while on it, as anybody would be before popping out. Straight after a
      // switch, the segments the page remembers are its new stream's first,
      // slow ones, and the page back lands further ahead and waits longer for
      // the room — on whichever stream it is put on.
      await pause(20_000);

      const poppedAt = Date.now();
      const frame = viewerFrame.current;
      if (frame) frame.src = frame.src;
      say(`… the viewer, on ${own}, reloaded at ${latest.get("u-viewer")?.pos.toFixed(1)}s`);
      let hostStoppedMs = 0;
      let last = Date.now();
      let backAt = 0;
      while (Date.now() - poppedAt < 30_000) {
        await pause(200);
        const now = Date.now();
        const h = latest.get("u-host");
        if (h && (h.paused || h.ready < 3)) hostStoppedMs += now - last;
        last = now;
        const reloaded = after(poppedAt, /^starting session$/).length > 0;
        if (!backAt && reloaded && inStep()) backAt = now;
      }
      const taken = after(poppedAt, /^(adopting the stream this client now drives|now driving this stream)$/).map((e) => String(e.data.variant));
      const asked = after(poppedAt, /^(asking for a stream at this quality|starting a stream for these tracks)$/);
      say(`    back: ${taken.join(" → ") || "nothing of its own"}${asked.length ? `; then asked for ${asked.map((e) => e.msg).join(", ")}` : ""}`);
      say(`${taken.length > 0 && taken.every((k) => k === own) ? "PASS" : "FAIL"} the page back is on its own stream again (${taken.at(-1) ?? "the host's"})`);
      say(`${after(poppedAt, /^adopting the stream this client now drives$/).length > 0 ? "PASS" : "FAIL"} taking up the transcode it was driving, not starting another`);
      say(`${asked.length === 0 ? "PASS" : "FAIL"} and asks for no other tracks or quality (${asked.length})`);
      say(`${hostStoppedMs < 1500 ? "PASS" : "FAIL"} the host played on (stopped ${(hostStoppedMs / 1000).toFixed(1)}s in all)`);
      say(`${backAt && backAt - poppedAt < 15_000 ? "PASS" : "FAIL"} the viewer was back, playing in step, ${backAt ? `${((backAt - poppedAt) / 1000).toFixed(1)}s after it reloaded` : "never"}`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * A title Plex gives the wrong length: the bar goes by the file's, once the
   * copy is made to its end. On 21 October Grimm S3E7, a 43-minute file,
   * showed as 97 hours, and the bar barely moved. A film whose two files Plex
   * adds up keeps Plex's length: the first file is not the whole.
   */
  async function runPlexLength() {
    setRunning(true);
    const out: string[] = ["— a title Plex gives the wrong length —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      for (const [plexS, fileWins] of [[3600, true], [200, false]] as const) {
        // The whole two minutes listed, and said to be all there is.
        await startOnce(`p2p=0&stream=copy4&event=1&eventS=200&endlist=1&plexS=${plexS}`, {}, 40_000);
        await pause(8_000);
        const h = latest.get("u-host");
        const pos = h?.pos ?? NaN;
        const want = (pos / (fileWins ? 120 : plexS)) * 100;
        const bar = h?.barPct ?? NaN;
        say(`    Plex says ${plexS}s, the file is 120s: at ${pos.toFixed(1)}s the bar is at ${bar.toFixed(2)}% (${want.toFixed(2)}% of ${fileWins ? "the file" : "Plex's"})`);
        say(`${Math.abs(bar - want) < 2 ? "PASS" : "FAIL"} ${fileWins ? "the bar goes by the file's length" : "the bar keeps Plex's length, not twice the file's"}`);
      }
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The host starting another title mid-film: everybody starts it together,
   * with a picture of it. The room's word that it waits for the new title
   * reaches a player before the title does, and on 13 October monkey26
   * answered it from the last film's buffer, 32 s of it in hand: the room
   * started without it, and it came in 2.5 s late with 0.4 s in hand.
   */
  async function runNextTitle() {
    setRunning(true);
    const out: string[] = ["— the host starting another title mid-film —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      await startOnce("p2p=0&stream=copy4&event=1&eventS=200", {}, 40_000);
      // Both well into it, with plenty of it in hand.
      await pause(15_000);
      const switchedAt = Date.now();
      (hostFrame.current?.contentWindow as unknown as { fixture?: { playTitle?: (k: string) => void } } | null)?.fixture?.playTitle?.("4343");
      const startedAt = (user: string) => (events.get(user) ?? []).find((e) => e.t > switchedAt && e.tag === "HLS" && e.msg === "starting session")?.t;
      const playsAt = (user: string) => {
        const from = startedAt(user);
        return from === undefined ? undefined : (events.get(user) ?? []).find((e) => e.t > from && e.tag === "Video" && e.msg === "playing");
      };
      const hostPlays = await waitFor(() => playsAt("u-host"), 45_000, "the host to start the new title");
      const viewerPlays = await waitFor(() => playsAt("u-viewer"), 45_000, "the viewer to start the new title");
      const viewerStream = startedAt("u-viewer")!;
      const early = (events.get("u-viewer") ?? []).filter((e) => e.t > switchedAt && e.t < viewerStream && /picture ready, telling the room/.test(e.msg));
      const apart = viewerPlays.t - hostPlays.t;
      say(`host started ${((hostPlays.t - switchedAt) / 1000).toFixed(1)}s after the switch, the viewer ${apart} ms after it, with ${Number(viewerPlays.data.bufAheadS).toFixed(1)}s in hand`);
      // Said, from the last film's picture, before the word of the new one came:
      // the room counts it for nothing (services/sync.ts, "ready").
      for (const e of early) say(`    before its new stream: ${e.msg} ${JSON.stringify({ gather: e.data.gather, inHandS: e.data.inHandS })}`);
      say(`${Math.abs(apart) < 3000 ? "PASS" : "FAIL"} the viewer starts the new title within seconds of the host, which waits for nobody (${apart} ms apart)`);
      await pause(10_000);
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`${Math.abs(h.pos - v.pos) < 1 && !h.paused && !v.paused ? "PASS" : "FAIL"} and play on together (${(v.pos - h.pos).toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * What the host's page holds in memory over a long copy, beyond what it has
   * downloaded — read after a garbage collection, which the runner allows
   * (--js-flags=--expose-gc), so that what is counted is what is kept. The P2P
   * engine keeps everything downloaded, up to its limit; nothing else should
   * grow with it. On 14 October Troy's page held 1.5 GB more than the engine
   * may keep after 9 GB downloaded, and climbing; on 11 October a page held
   * 150 to 260 MB more after as much, and flat.
   */
  async function runMemory(engineMiB = 0, query = "", skips = false, kbps = 0) {
    setRunning(true);
    const out: string[] = [`— the players' memory over a long copy${engineMiB ? `, the P2P engine kept to ${engineMiB} MiB` : ""}${skips ? ", the host skipping ahead" : ""}${kbps ? `, downloads at ${kbps / 1000} Mbps` : ""}${query ? ` (${query})` : ""} —`];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      await startOnce(`p2p=0&stream=copy4long&event=1&eventS=300&cache=1${query}`, kbps ? { "u-host": kbps, "u-viewer": kbps } : {}, 0, engineMiB ? `&engineMiB=${engineMiB}` : "");
      const win = hostFrame.current?.contentWindow as unknown as { gc?: () => void; performance: Performance & { memory?: { usedJSHeapSize: number } } } | null;
      const heldMB = () => { win?.gc?.(); return (win?.performance.memory?.usedJSHeapSize ?? 0) / 1e6; };
      // Both players: frames of one site share a page's memory, and what it
      // reports is all of it.
      const gotMB = async () => (await api("/api/test/served") as Served[])
        .reduce((n, x) => n + (x.sent ?? x.bytes ?? 0), 0) / 1e6;
      say(`    collected here: ${win?.gc ? "yes" : "no — the runner has to (HeapProfiler.collectGarbage)"}`);
      let first = { held: heldMB(), got: await gotMB() };
      let last = first;
      for (let i = 1; i <= 9; i++) {
        // Ten seconds on, as on Troy on 14 October, a skip or two a minute.
        if (skips) { await pause(10_000); hostKey("ArrowRight"); await pause(10_000); }
        else await pause(20_000);
        last = { held: heldMB(), got: await gotMB() };
        say(`    ${i * 20}s: ${last.held.toFixed(0)} MB held, ${last.got.toFixed(0)} MB downloaded`);
        // With the engines kept small, they are full by the first sample: from there.
        if (i === 1 && engineMiB) first = last;
      }
      const health = (events.get("u-host") ?? []).filter((e) => e.tag === "Health" && e.msg === "sample").at(-1)?.data;
      say(`    the host's last sample: engine ${health?.engineMB ?? "?"} MB in ${health?.engineSegments ?? "?"} segments, kept for the page after ${health?.keptMB ?? "?"} MB, keeping ${health?.keeping ?? "?"}, let go by ${health?.notKept ?? "?"}`);
      const grew = last.held - first.held;
      const got = last.got - first.got;
      if (engineMiB) {
        // Each engine full from the first sample on: what is held stays put.
        say(`${grew < 40 ? "PASS" : "FAIL"} what is held stops growing once the engines are full (${grew.toFixed(0)} MB more held for ${got.toFixed(0)} MB more downloaded)`);
      } else {
        say(`${grew - got < 30 ? "PASS" : "FAIL"} it holds no more than it downloads (${grew.toFixed(0)} MB more held for ${got.toFixed(0)} MB more downloaded)`);
      }
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * A viewer joining a film already playing, whose picture stops just after it
   * starts: getting going, it catches up on its own, and the host — the room —
   * plays on. On 13 October monkey26 joined, stopped two seconds in, and the
   * whole room waited nineteen seconds for it, the host with forty in hand.
   *
   * `afterS`: stopping that long after it starts instead, never having had
   * much in hand — on 14 October monkey26, back from a pop-out, stopped at 33
   * seconds and the room held thirty for it, the host with a minute in hand.
   */
  async function runJoinerStalls(afterS = 0) {
    setRunning(true);
    const out: string[] = [afterS
      ? `— a viewer joining a film already playing, its picture stopping ${afterS}s after it starts, little ever in hand —`
      : "— a viewer joining a film already playing, its picture stopping just after it starts —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      latest.clear();
      events.clear();
      await api("/api/test/reset?p2p=0");
      viewerQuery = "&latejoin";
      setHostOn(false);
      setFrames(nextFrames(currentGen));
      setHostOn(true);
      await waitFor(() => { const h = latest.get("u-host"); return !!h && !h.paused && h.pos > 20; }, 90_000, "the host 20s in");
      // Its connection a little faster than the film, so it has seconds in
      // hand rather than the rest of the film, as a joiner on a real one does.
      await api("/api/test/pace?user=u-viewer&ms=2600");
      const joinedAt = Date.now();
      (viewerFrame.current?.contentWindow as Window | null | undefined)?.postMessage({ kind: "press", press: ["Join"] }, "*");
      await waitFor(() => firstPlay("u-viewer"), 60_000, "the viewer to play");
      if (afterS) {
        await pause(afterS * 1000);
        const most = Math.max(0, ...(events.get("u-viewer") ?? []).filter((e) => e.t > joinedAt && typeof e.data.inHandS === "number").map((e) => Number(e.data.inHandS)));
        say(`    the joiner ${afterS}s in, the most it said it had in hand ${most.toFixed(1)}s`);
      }
      // Its next segments held back as soon as it plays.
      await api("/api/test/stall?user=u-viewer&ms=12000");
      await pause(25_000);
      const host = events.get("u-host") ?? [];
      const held = host.filter((e) => e.t > joinedAt && /holding for the room/.test(e.msg));
      say(`${held.length === 0 ? "PASS" : "FAIL"} the host never holds for the joiner (${held.length})`);
      const stopped = host.filter((e) => e.t > joinedAt && e.tag === "Video" && /buffer starved/.test(e.msg));
      say(`${stopped.length === 0 ? "PASS" : "FAIL"} nor stops (${stopped.length})`);
      const asked = (events.get("u-viewer") ?? []).filter((e) => /asking the room to wait for it/.test(e.msg));
      say(`${asked.length === 0 ? "PASS" : "FAIL"} the joiner, getting going, doesn't ask the room to wait (${asked.length})`);
      await pause(10_000);
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      // A few seconds behind after its stop, it closes the gap by playing a
      // little faster once it has six seconds in hand (SOFT_SYNC_MIN_BUFFER_S),
      // which on a connection this close to the film's own speed takes a while.
      say(`${Math.abs(v.pos - h.pos) < 4 && !v.paused && !h.paused ? "PASS" : "FAIL"} and it plays on with the host, within the few seconds it closes unseen (${(v.pos - h.pos).toFixed(2)}s apart)`);
      const caught = (events.get("u-viewer") ?? []).filter((e) => e.t > joinedAt && /catching up with the room|heartbeat drift correction|going past it/.test(e.msg));
      say(`    caught up: ${caught.map((e) => e.msg).join("; ") || "no need"}`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      viewerQuery = "";
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The viewer's picture stopping mid-film for want of data, while the host's
   * plays on: the room waits for the host's picture alone, so it plays on, and
   * the viewer — on its own loading screen meanwhile — comes back in step, in
   * one move: nothing shown twice, no stops and starts to get there.
   */
  async function runViewerStall() {
    setRunning(true);
    const out: string[] = ["— the viewer's picture stopping mid-film —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    latest.clear();
    events.clear();
    const { samples, stop } = sampleBoth();
    try {
      await api("/api/test/reset?p2p=0");
      // The viewer's connection a little faster than the stream, so its buffer stays short.
      await api("/api/test/pace?user=u-viewer&ms=2600");
      setHostOn(false);
      setFrames(nextFrames);
      await waitFor(() => latest.get("u-viewer")?.joined, 60_000, "the viewer to join");
      setHostOn(true);
      await waitFor(() => firstPlay("u-host") && firstPlay("u-viewer"), 60_000, "both to start");
      await pause(8_000);
      say("… holding the viewer's stream back for 20s");
      const from = samples.length;
      await api("/api/test/stall?user=u-viewer&ms=20000");
      const stoppedAt = await waitFor(() => {
        const v = latest.get("u-viewer");
        return v && !v.paused && v.ready < 3 ? v.t : null;
      }, 40_000, "the viewer's picture to stop");
      const backAt = await waitFor(() => {
        const v = latest.get("u-viewer");
        return v && v.t > stoppedAt + 3000 && !v.paused && v.ready >= 3 ? v.t : null;
      }, 60_000, "the viewer's picture to come back");
      await pause(10_000);
      stop();
      const during = samples.slice(from);
      const held = during.filter((s) => s.t > stoppedAt && (s.host.paused || s.host.waiting)).length;
      say(`${held === 0 ? "PASS" : "FAIL"} the host plays on while the viewer's picture is stopped (${held} samples held)`);
      const own = during.filter((s) => s.t > stoppedAt && s.t < backAt && s.viewer.loading).length;
      say(`${own > 0 ? "PASS" : "FAIL"} the viewer on its own loading screen meanwhile`);
      const back = during.slice(1).map((s, i) => s.viewer.pos - during[i].viewer.pos).filter((d) => d < -0.05);
      say(`${back.length === 0 ? "PASS" : "FAIL"} never sent back${back.length ? ` (${back.map((d) => d.toFixed(2)).join(", ")}s)` : ""}`);
      // Back in step the moment its picture moves again, not behind and then
      // moved: a picture moving before and after a jump is a stutter.
      const backSample = during.find((s) => s.t >= backAt);
      const backApart = backSample ? Math.abs(backSample.viewer.pos - backSample.host.pos) : NaN;
      say(`${backApart < 1 ? "PASS" : "FAIL"} its picture comes back in step with the room (${backApart.toFixed(2)}s apart)`);
      const moving = during.filter((s) => s.t > backAt);
      const jumps = moving.slice(1).map((s, i) => s.viewer.pos - moving[i].viewer.pos).filter((d) => d > 1.5);
      say(`${jumps.length === 0 ? "PASS" : "FAIL"} and isn't moved again once it plays${jumps.length ? ` (${jumps.map((d) => d.toFixed(2)).join(", ")}s)` : ""}`);
      const asked = (events.get("u-viewer") ?? []).some((e) => /asking the room to wait for it/.test(e.msg));
      say(`${!asked ? "PASS" : "FAIL"} without asking the room to wait for it`);
      const end = during[during.length - 1];
      const apart = Math.abs(end.viewer.pos - end.host.pos);
      say(`${apart < 1 && !end.viewer.paused && !end.host.paused ? "PASS" : "FAIL"} and they play on together (${apart.toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      stop();
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * The viewer's picture stopping with the buffer in front of it, as a decoder
   * can: on 16 October one viewer's stuck three seconds into every episode,
   * ten seconds in hand, and the whole room stopped two seconds for it each
   * time. The room plays on, and the viewer is going again, in step, at once.
   */
  async function runViewerFreeze() {
    setRunning(true);
    const out: string[] = ["— the viewer's picture stuck with the buffer ahead of it —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    latest.clear();
    events.clear();
    const { samples, stop } = sampleBoth();
    try {
      await api("/api/test/reset?p2p=0");
      setHostOn(false);
      setFrames(nextFrames);
      await waitFor(() => latest.get("u-viewer")?.joined, 60_000, "the viewer to join");
      setHostOn(true);
      await waitFor(() => firstPlay("u-host") && firstPlay("u-viewer"), 60_000, "both to start");
      await pause(8_000);
      const from = samples.length;
      const frozenAt = Date.now();
      const frozenPos = latest.get("u-viewer")!.pos;
      (viewerFrame.current?.contentWindow as Window | null | undefined)?.postMessage({ kind: "freeze" }, "*");
      say(`… the viewer's picture stuck at ${frozenPos.toFixed(1)}s with the buffer ahead`);
      const goingAt = await waitFor(() => {
        const v = latest.get("u-viewer");
        return v && v.t > frozenAt + 300 && v.ready >= 3 && !v.paused && v.pos > frozenPos + 0.3 ? v.t : null;
      }, 30_000, "the viewer's picture to go again");
      await pause(8_000);
      stop();
      const during = samples.slice(from);
      const held = during.filter((s) => s.t > frozenAt && (s.host.paused || s.host.waiting)).length;
      say(`${held === 0 ? "PASS" : "FAIL"} the host plays on (${held} samples held)`);
      say(`${goingAt - frozenAt < 1500 ? "PASS" : "FAIL"} the viewer is going again within a second and a half (${goingAt - frozenAt} ms)`);
      const back = during.slice(1).map((s, i) => s.viewer.pos - during[i].viewer.pos).filter((d) => d < -0.05);
      say(`${back.length === 0 ? "PASS" : "FAIL"} never sent back${back.length ? ` (${back.map((d) => d.toFixed(2)).join(", ")}s)` : ""}`);
      const moves = (events.get("u-viewer") ?? []).filter((e) => e.t > frozenAt && /catching up with the room|stepping it|drift correction|correcting to room|going past it/.test(e.msg));
      say(`${moves.length === 1 ? "PASS" : "FAIL"} in one move (${moves.map((e) => e.msg).join("; ") || "none"})`);
      const asked = (events.get("u-viewer") ?? []).some((e) => e.t > frozenAt && /asking the room to wait for it/.test(e.msg));
      say(`${!asked ? "PASS" : "FAIL"} without asking the room to wait for it`);
      const end = during[during.length - 1];
      const apart = Math.abs(end.viewer.pos - end.host.pos);
      say(`${apart < 1 && !end.viewer.paused && !end.host.paused ? "PASS" : "FAIL"} and they play on together (${apart.toFixed(2)}s apart)`);
    } catch (err) {
      say(`FAIL ${String(err)}`);
    } finally {
      stop();
      (window as unknown as { results?: string[]; events?: typeof events }).results = out;
      (window as unknown as { events?: typeof events }).events = events;
      setRunning(false);
    }
  }

  /**
   * Both players on one connection a little slower than the film — a copy of
   * 8 Mbps, the bot's upload 14 Mbps between the two: started with three
   * seconds in hand, each stopped every twenty-odd seconds, and every stop is
   * the room's. They wait a little longer to start, for more in hand — ten
   * seconds more at most (lib/readyCushion) — and stop once at most in the
   * minute after; then, having stopped, they wait for more again.
   */
  async function runSlowLink() {
    setRunning(true);
    const out: string[] = ["— a connection a little slower than the film —"];
    const say = (line: string) => { out.push(line); setLines([...out]); };
    setLines([...out]);
    try {
      const r = await startOnce("p2p=0&stream=copy4", {}, 14_000);
      say(`started ${r.startS.toFixed(1)}s after play, host ${r.hostAheadS.toFixed(1)}s in hand, viewer ${r.viewerAheadS.toFixed(1)}s, ${r.apartMs} ms apart`);
      say(`    the viewer started ${r.apartMs} ms after the host, the room waiting for nobody but it`);
      say(`${r.hostAheadS >= 6 ? "PASS" : "FAIL"} with more in hand than the three seconds it used to start on (${r.hostAheadS.toFixed(1)}s)`);
      const startedAt = Date.now();
      await pause(60_000);
      // A stop anybody sees: half a second or more, which the loading screen
      // goes up for, until the picture plays again. The element also says it
      // is waiting for a few milliseconds at a segment that comes just in time.
      const stops = (user: string) => {
        const video = (events.get(user) ?? []).filter((e) => e.t > startedAt && e.tag === "Video");
        return video.filter((e, i) => /waiting \(buffer starved\)/.test(e.msg) &&
          (video.slice(i + 1).find((n) => n.msg === "playing")?.t ?? Infinity) - e.t >= 500).length;
      };
      say(`${stops("u-host") <= 1 && stops("u-viewer") <= 1 ? "PASS" : "FAIL"} and each stops once at most in the minute after (host ${stops("u-host")}, viewer ${stops("u-viewer")})`);
      const h = latest.get("u-host")!;
      const v = latest.get("u-viewer")!;
      say(`${Math.abs(v.pos - h.pos) < 1 && !h.paused && !v.paused ? "PASS" : "FAIL"} and they are together (${Math.abs(v.pos - h.pos).toFixed(2)}s apart)`);
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
      // (Without P2P, then for 25s: see below.)
      await api("/api/test/stall?user=u-host&ms=8000");
      const stallFrom = samples.length;
      if (p2p) {
        await pause(20_000);
        window.clearInterval(sampler);
        const stopped = samples.slice(stallFrom).filter((s) => !s.host.paused && s.host.ready < 3).length;
        say(`${stopped <= 2 ? "PASS" : "FAIL"} the viewer's segments carry the host through its stall (stopped in ${stopped} samples)`);
      } else {
        // What it went on with is picture enough to ride a hold like that out
        // (lib/readyCushion); a longer one stops it.
        await pause(12_000);
        const shortStops = samples.slice(stallFrom).filter((s) => !s.host.paused && s.host.ready < 3).length;
        say(`${shortStops <= 2 ? "PASS" : "FAIL"} the host rides that out on what it has in hand (stopped in ${shortStops} samples)`);
        say("… and back for 25s");
        await api("/api/test/stall?user=u-host&ms=25000");
        const longFrom = samples.length;
        const hostStalled = await waitFor(() => {
          const h = latest.get("u-host");
          return h && !h.paused && h.ready < 3 ? h.t : null;
        }, 40_000, "the host's picture to stop");
        say(`(the host's picture stopped ${Math.round((hostStalled - samples[longFrom].t) / 100) / 10}s after)`);
        await waitFor(() => { const h = latest.get("u-host"); return h && h.ready >= 3 && !h.paused; }, 45_000, "the host to go on");
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
        <button disabled={running} onClick={() => void runViewerStall()}>Viewer stalls</button>
        <button disabled={running} onClick={() => void runViewerFreeze()}>Viewer's picture freezes</button>
        <button disabled={running} onClick={() => void runSlowLink()}>Slow connection</button>
        <button disabled={running} onClick={() => void runStartup()}>Start-up</button>
        <button disabled={running} onClick={() => void runHostCrawls()}>Host's downloads crawl</button>
        <button disabled={running} onClick={() => void runCopySkip()}>Skip in a copy</button>
        <button disabled={running} onClick={() => void runCopySkipInPlace(false)}>Skip ahead inside a copy</button>
        <button disabled={running} onClick={() => void runCopySkipInPlace(true)}>Skip ahead inside a copy, P2P</button>
        <button disabled={running} onClick={() => void runCopySkipInPlace(false, 8_000)}>Skip ahead inside a copy, slow</button>
        <button disabled={running} onClick={() => void runCopySkipInPlace(false, 30_000, 180)}>Skip far ahead inside a copy</button>
        <button disabled={running} onClick={() => void runPlexLength()}>Plex's length far too long</button>
        <button disabled={running} onClick={() => void runLateJoin()}>Late joiner</button>
        <button disabled={running} onClick={() => void runHandToJoiner()}>Host handed to a joiner</button>
        <button disabled={running} onClick={() => void runSkipBurst()}>Skips in a burst, in a copy</button>
        <button disabled={running} onClick={() => void runPopOut("host")}>Host pops out</button>
        <button disabled={running} onClick={() => void runPopOut("viewer")}>Viewer pops out</button>
        <button disabled={running} onClick={() => void runPopOut("host", "slow")}>Host pops out, slow back</button>
        <button disabled={running} onClick={() => void runPopOut("host", "long")}>Host pops out, long back</button>
        <button disabled={running} onClick={() => void runPopOutCache()}>Pop out, from the cache</button>
        <button disabled={running} onClick={() => void runPopOutCache("viewer")}>Viewer pops out, from the cache</button>
        <button disabled={running} onClick={() => void runPopOutCache("viewer", true)}>Viewer pops out, browser's cache let go</button>
        <button disabled={running} onClick={() => void runPopOutOwnTracks()}>Viewer pops out, own tracks</button>
        <button disabled={running} onClick={() => void runHostBackOwnStream()}>Host back where it can't play the room's stream</button>
        <button disabled={running} onClick={() => void runHostBackOwnStream(true)}>Host back on a stream that barely keeps up</button>
        <button disabled={running} onClick={() => void runJoinWhileAhead()}>Join while ahead</button>
        <button disabled={running} onClick={() => void runNextTitle()}>Next title, together</button>
        <button disabled={running} onClick={() => void runJoinerStalls()}>Joiner stalls</button>
        <button disabled={running} onClick={() => void runJoinerStalls(35)}>Joiner stalls later</button>
        <button disabled={running} onClick={() => void runMemory()}>Memory over a long copy</button>
        <button disabled={running} onClick={() => void runMemory(60)}>Memory, engine full</button>
        <button disabled={running} onClick={() => void runMemory(60, "&parts=0")}>Memory, engine full, no parts</button>
        <button disabled={running} onClick={() => void runMemory(60, "", true)}>Memory, engine full, skipping</button>
        <button disabled={running} onClick={() => void runMemory(60, "", true, 12000)}>Memory, engine full, skipping, slow</button>
        <button disabled={running} onClick={() => void runMemory(60, "&parts=0", true)}>Memory, engine full, skipping, no parts</button>
        <button disabled={running} onClick={() => void runAlonePopOut()}>Host alone pops out</button>
        <button disabled={running} onClick={() => void runPreviewAhead()}>Preview frames from the title's page</button>
        <button disabled={running} onClick={() => void runSkipThenPause()}>Skip then pause</button>
        <button disabled={running} onClick={() => void runKeyframeStart()}>Keyframe start</button>
        <button disabled={running} onClick={() => void runBufferedSkip()}>Skip in the buffer</button>
        <button disabled={running} onClick={() => void runRewind()}>Rewind</button>
        <button disabled={running} onClick={() => void runSeekingWords()}>Seeking words</button>
        <button disabled={running} onClick={() => void runMessages()}>Messages</button>
        <button disabled={running} onClick={() => void runSubtitleReads()}>Subtitles as read</button>
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
