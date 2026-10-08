// One player in the sync-room fixture — see sync-room.tsx. The real Player
// over real hls.js and the real P2P engine, in the real room: useSync against
// the real sync server that sync-room-server.ts runs. ?user=u-host is the host.
import React from "react";
import { createRoot } from "react-dom/client";
import { Player } from "../src/components/Player";
import { useSync } from "../src/hooks/useSync";
import { setSessionToken, type PlexItem } from "../src/lib/api";

const user = new URLSearchParams(location.search).get("user") ?? "u-viewer";
/** Which run of the checks this frame belongs to: a frame being replaced can still report. */
const gen = new URLSearchParams(location.search).get("gen");
const isHost = user === "u-host";
/** Where the host's player resumes the film from, if anywhere. */
const resume = Number(new URLSearchParams(location.search).get("resume")) || undefined;
const item: PlexItem = { ratingKey: "4242", title: "Sync Test", type: "movie", thumb: null, duration: 120_000 } as PlexItem;

// Muted for good, so the browser lets it play without anyone clicking in this
// frame — and keeps letting it: un-muting a video that started muted without
// a click pauses it, and the player restores its saved volume as it starts.
// ?whisper plays it unmuted at a whisper instead, where the browser allows
// that: a muted video in a page nobody can see is paused a few seconds in.
const whisper = new URLSearchParams(location.search).has("whisper");
const mutedProp = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "muted")!;
const volumeProp = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "volume")!;
Object.defineProperty(HTMLMediaElement.prototype, "muted", {
  configurable: true,
  get(this: HTMLMediaElement) { return mutedProp.get!.call(this); },
  set(this: HTMLMediaElement) { mutedProp.set!.call(this, !whisper); },
});
if (whisper) {
  Object.defineProperty(HTMLMediaElement.prototype, "volume", {
    configurable: true,
    get(this: HTMLMediaElement) { return volumeProp.get!.call(this); },
    set(this: HTMLMediaElement) { volumeProp.set!.call(this, 0.001); },
  });
}
const play = HTMLMediaElement.prototype.play;
HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
  this.muted = true;
  if (whisper) this.volume = 0.001;
  return play.call(this);
};

// Looked at, as two people's players are, even when the browser running the
// checks is in the background: the room doesn't wait for a player nobody is
// looking at.
Object.defineProperty(Document.prototype, "hidden", { configurable: true, get: () => false });
Object.defineProperty(Document.prototype, "visibilityState", { configurable: true, get: () => "visible" });

// This player's own account of itself, for the runner to read.
const events: Array<{ t: number; tag: string; msg: string; data: Record<string, unknown> }> = [];
for (const level of ["log", "warn", "error"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const m = typeof args[0] === "string" ? args[0].match(/^\[([\w ]+)\] (.*)$/) : null;
    if (m) events.push({ t: Date.now(), tag: m[1], msg: m[2], data: (args[1] ?? {}) as Record<string, unknown> });
    original(...args);
  };
}
// Who pauses the picture, when something does: the player logs its own
// reasons, and a pause with none is either the browser or a bug.
const pauseFn = HTMLMediaElement.prototype.pause;
HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
  events.push({ t: Date.now(), tag: "Fixture", msg: "pause() called", data: { stack: new Error().stack?.split("\n").slice(2, 6).join(" | ") } });
  return pauseFn.call(this);
};
const fixture: Record<string, unknown> = { events, user, isHost };
(window as unknown as { fixture: typeof fixture }).fixture = fixture;

// Reported to the runner, which can't reach in: the two players are on
// different origins (two ports), as two people's are on
// different machines. On one origin they share the browser's six connections
// to it, and one player's held-back downloads queued the other's behind them.
let sent = 0;
setInterval(() => {
  const v = document.querySelector("video");
  const sync = fixture.sync as { hostWaiting?: boolean } | undefined;
  parent.postMessage({
    kind: "sample", user, gen, t: Date.now(),
    pos: v?.currentTime ?? 0, paused: v?.paused ?? true, ready: v?.readyState ?? 0,
    waiting: !!sync?.hostWaiting, text: document.body.innerText, joined: !!fixture.joined,
    loading: document.querySelector("[data-loading-screen]")?.textContent ?? null,
    events: events.slice(sent),
  }, "*");
  sent = events.length;
}, 200);

const { token, instanceId } = await (await fetch(`/api/test/session?user=${user}`)).json() as { token: string; instanceId: string };
setSessionToken(token);

function Room() {
  // A viewer joins with a click, as one does in Discord — and the browser
  // will only keep a picture playing in a frame someone has clicked in.
  const [joined, setJoined] = React.useState(isHost || new URLSearchParams(location.search).has("autojoin"));
  fixture.joined = joined;
  const { state, actions } = useSync({ instanceId, userId: user, username: isHost ? "Host" : "Viewer", enabled: joined });
  fixture.sync = state;
  fixture.actions = actions;
  // The host stopping the film and starting it again, as a new stream.
  const [stopped, setStopped] = React.useState(false);
  const [mount, setMount] = React.useState(0);
  fixture.newStream = () => {
    setStopped(true);
    actions.sendStop();
    setTimeout(() => { setStopped(false); setMount((n) => n + 1); }, 1500);
  };
  if (!joined) {
    return (
      <button style={{ width: "100%", height: "100%", font: "600 24px system-ui", background: "#222", color: "#fff", border: 0 }}
        onClick={() => setJoined(true)}>Join</button>
    );
  }
  // A viewer opens the player when the room has something playing, as the app does.
  if (!isHost && state.ratingKey !== item.ratingKey) return <p style={{ color: "#aaa" }}>Viewer: waiting for the host to start…</p>;
  if (stopped) return <p style={{ color: "#aaa" }}>Host: stopped</p>;
  return (
    <Player key={mount} item={item} isHost={isHost} selfUserId={user} subtitles={false}
      resumePosition={mount === 0 ? resume : undefined}
      sharePresenceDetails={false} onSharePresenceDetails={() => {}} onBack={() => {}}
      syncState={state} syncActions={actions} presentation="full" />
  );
}
createRoot(document.getElementById("root")!).render(<Room />);
