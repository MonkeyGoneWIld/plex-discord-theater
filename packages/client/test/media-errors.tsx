// Manual/DOM regression fixture for streams that won't decode. Run
//   node packages/client/test/media-errors-server.mjs
// and npm run dev -w packages/client, then open /test/media-errors.html. This
// mounts the actual Player as host over real hls.js, against a stream with
// segments replaced by bytes that can't be parsed. Not in the production entry.
//
// What it guards against: a fragment that downloads but won't decode used to
// reset the recovery budget it had just spent, so the player detached and
// reattached the picture several times a second forever — the flicker — and a
// position read from the detached element sent the room back to 0:00. Near the
// end, where Plex pads a stream that stopped short with blank segments, even a
// few recovery attempts were a stutter, and the padding played on as if it were
// the episode.
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Player } from "../src/components/Player";
import type { PlexItem } from "../src/lib/api";
import type { SyncActions, SyncState } from "../src/hooks/useSync";

const STREAMS = "http://localhost:3999";
// The player asks the app's server for its stream; hls.js loads over XHR, so
// send those requests to the fixture's stream server instead.
const open = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...args: unknown[]) => void;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  const m = String(url).match(/\/api\/plex\/hls\/([^/]+)\/[^/]+\/(.+)$/);
  open.call(this, method, m ? `${STREAMS}/${m[1]}/${m[2]}` : url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

const episode = (ratingKey: string): PlexItem => ({
  ratingKey, title: "Episode One", type: "episode", thumb: null,
  showTitle: "Test Show", parentIndex: 1, index: 1, duration: 120_000,
});
const next: PlexItem = { ...episode("next"), title: "Episode Two", index: 2 };
window.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/api/plex/config")) return Response.json({ vpsRelay: true });
  if (url.includes("/played-threshold")) return Response.json({ threshold: 0.9 });
  if (url.includes("/meta/")) return Response.json({ ...episode("x"), partId: null, markers: [], genres: [], versions: [], audioTracks: [], subtitleTracks: [] });
  if (url.includes("/siblings/")) return Response.json({ episode: true, prev: null, next });
  return Response.json({});
};

// The player's own account of itself, and every position it told the room.
const events: Array<{ msg: string; data: Record<string, any> }> = [];
for (const level of ["log", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    if (typeof args[0] === "string" && /^\[(HLS|Host|Stall)\] /.test(args[0])) {
      events.push({ msg: args[0].replace(/^\[\w+\] /, ""), data: (args[1] ?? {}) as Record<string, any> });
    }
    original(...args);
  };
}
const positions: Array<{ name: string; at: number }> = [];
const syncActions = new Proxy({}, {
  get: (_t, name) => (...args: unknown[]) => {
    if (name === "sendPause" || name === "sendResume" || name === "sendHeartbeat") {
      positions.push({ name: String(name), at: Number(args[0]) });
    }
  },
}) as unknown as SyncActions;
const state = { participants: [], queue: [], commandSeq: 0, stateSeq: 0, seekSeq: 0, connected: false } as unknown as SyncState;

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const count = (text: string) => events.filter((e) => e.msg.includes(text)).length;
const find = (text: string) => events.find((e) => e.msg.includes(text));
const shows = (text: string) => document.body.innerText.includes(text);
async function waitFor(condition: () => unknown, ms: number, what: string) {
  for (const end = Date.now() + ms; Date.now() < end; await pause(250)) if (condition()) return;
  throw new Error(`Timed out waiting for ${what}`);
}

function Fixture() {
  const [scenario, setScenario] = useState<{ key: number; ratingKey: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const start = async (ratingKey: string) => {
    events.length = 0;
    positions.length = 0;
    setScenario((s) => ({ key: (s?.key ?? 0) + 1, ratingKey }));
    await waitFor(() => document.querySelector("video"), 5_000, "the player");
  };
  async function run() {
    setRunning(true); setResults([]);
    const pass = (text: string) => setResults((lines) => [...lines, `PASS ${text}`]);
    try {
      await start("tail");
      await waitFor(() => find("stream breaks near the end"), 20_000, "the end-of-stream decision");
      const decision = find("stream breaks near the end")!;
      check(decision.data.breakAtS > 108 && decision.data.breakAtS < 114, `Break placed at ${decision.data.breakAtS}s, not ~111s`);
      check(count("recoverMediaError") === 0, `${count("recoverMediaError")} media recoveries — each one is a stutter`);
      check(count("auto-recovery scheduled") === 0, "Restarted a transcode for a break past the watched point");
      pass("A break near the end is taken as the end at once, with no recovery attempts to stutter");
      const breakAt = Math.floor(decision.data.breakAtS);
      const spans = `/ ${Math.floor(breakAt / 60)}:${String(breakAt % 60).padStart(2, "0")}`;
      await waitFor(() => document.body.textContent?.includes(spans), 3_000, `the timeline to read "${spans}"`);
      pass("The timeline ends at the break, not at the padded runtime");
      document.querySelector("video")!.currentTime = 105;
      await waitFor(() => find("reached the break"), 20_000, "playback to reach the break");
      const endedAt = find("reached the break")!.data.posS;
      check(endedAt > 109 && endedAt < 112, `Ended at ${endedAt}s, not at the break`);
      await waitFor(() => shows("Episode Two"), 5_000, "the end screen");
      check(count("starting session") === 1, `${count("starting session")} sessions started for one play`);
      pass("The title ends at the break, not after the padding that parsed, and offers the next episode");
      const reached = positions.findIndex((p) => p.at >= 100);
      check(reached >= 0, "The room never heard the position past 100s");
      const behind = positions.slice(reached).filter((p) => p.at < 100);
      check(behind.length === 0, `Sent ${behind.map((p) => `${p.name}@${p.at}`).join(", ")} after reaching 100s`);
      pass("No position from a detached element reaches the room");

      // Plex's other padding: segments that parse cleanly but carry sound only.
      // No error ever fires; this used to stall at the last frame, "buffering",
      // with the scrub bar still reading the full runtime.
      await start("silent");
      await waitFor(() => find("stream breaks near the end"), 20_000, "the picture's end to be noticed");
      const silentBreak = find("stream breaks near the end")!.data.breakAtS;
      check(silentBreak > 108 && silentBreak < 112, `Picture's end placed at ${silentBreak}s, not ~111s`);
      check(count("fatal error") === 0 && count("recoverMediaError") === 0, "Errors or recoveries for a stream that parses cleanly");
      const silentAt = Math.floor(silentBreak);
      const silentSpans = `/ ${Math.floor(silentAt / 60)}:${String(silentAt % 60).padStart(2, "0")}`;
      await waitFor(() => document.body.textContent?.includes(silentSpans), 3_000, `the timeline to read "${silentSpans}"`);
      pass("Sound-only padding is noticed as soon as it loads, and the timeline ends at the last frame");
      document.querySelector("video")!.currentTime = 105;
      await waitFor(() => find("reached the break"), 20_000, "playback to reach the last frame");
      const silentEnded = find("reached the break")!.data.posS;
      check(silentEnded > 109 && silentEnded < 112, `Ended at ${silentEnded}s, not at the last frame`);
      await waitFor(() => shows("Episode Two"), 5_000, "the end screen");
      check(count("wedged") === 0, "Sat stalled at the last frame before ending");
      pass("The title ends at the last frame instead of buffering, and offers the next episode");

      await start("middle");
      await waitFor(() => shows("Stream lost"), 40_000, "the stream-lost panel");
      check(count("stream breaks near the end") === 0, "Ended the title at a break halfway through");
      check(count("recoverMediaError") <= 3, `${count("recoverMediaError")} media recoveries — the loop is back`);
      check(count("starting session") <= 3, `${count("starting session")} sessions — rebuilds didn't stop`);
      pass("A break mid-film is retried a bounded number of times, then offered for manual retry");
    } catch (error) {
      setResults((lines) => [...lines, `FAIL ${String(error)}`]);
    } finally {
      setRunning(false);
    }
  }
  return <>
    <main>
      <h1>Broken-stream checks</h1>
      <p>Real player over real hls.js. Needs the fixture stream server running (see the top of media-errors.tsx).</p>
      <div className="tools">
        <button disabled={running} onClick={() => void start("tail")}>Play: breaks near the end</button>
        <button disabled={running} onClick={() => void start("silent")}>Play: picture ends early</button>
        <button disabled={running} onClick={() => void start("middle")}>Play: breaks mid-film</button>
        <button disabled={running} onClick={run}>{running ? "Checking…" : "Run checks"}</button>
      </div>
      <pre id="results" aria-live="polite">{results.join("\n")}</pre>
    </main>
    {scenario && (
      <Player key={scenario.key} item={episode(scenario.ratingKey)} isHost selfUserId="self" subtitles={false}
        sharePresenceDetails={false} onSharePresenceDetails={() => {}} onBack={() => setScenario(null)}
        syncState={state} syncActions={syncActions} presentation="full" />
    )}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
