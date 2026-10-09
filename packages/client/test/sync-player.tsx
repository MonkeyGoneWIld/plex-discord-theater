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
const titled = (ratingKey: string): PlexItem =>
  ({ ratingKey, title: `Sync Test ${ratingKey}`, type: "movie", thumb: null, duration: 120_000 }) as PlexItem;
const firstItem = titled("4242");

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

// Each of the media source's buffers on its own — the element's `buffered` is
// only where they all overlap, so a picture with no sound reads as nothing.
const sourceBuffers: Array<{ mime: string; sb: SourceBuffer }> = [];
const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
  const sb = addSourceBuffer.call(this, mime);
  sourceBuffers.push({ mime, sb });
  return sb;
};
fixture.sourceBuffers = sourceBuffers;
// Every append and removal, with what each buffer held after it.
const bufferOps: Array<Record<string, unknown>> = [];
fixture.bufferOps = bufferOps;
const rangesOf = (sb: SourceBuffer) => {
  try {
    return Array.from({ length: sb.buffered.length }, (_, i) => `${sb.buffered.start(i).toFixed(3)}-${sb.buffered.end(i).toFixed(3)}`).join(" ");
  } catch {
    return "removed";
  }
};
for (const op of ["appendBuffer", "remove"] as const) {
  const native = SourceBuffer.prototype[op] as (...args: unknown[]) => void;
  (SourceBuffer.prototype as unknown as Record<string, unknown>)[op] = function (this: SourceBuffer, ...args: unknown[]) {
    const mime = sourceBuffers.find((x) => x.sb === this)?.mime.split(";")[0] ?? "?";
    const entry: Record<string, unknown> = {
      op, mime, at: Number((document.querySelector("video")?.currentTime ?? 0).toFixed(3)),
      offset: this.timestampOffset, before: rangesOf(this),
      ...(op === "remove" ? { range: args.map((a) => Number(a).toFixed(3)).join("-") } : { bytes: (args[0] as ArrayBufferView | ArrayBuffer).byteLength }),
    };
    bufferOps.push(entry);
    this.addEventListener("updateend", () => { entry.after = rangesOf(this); }, { once: true });
    return native.apply(this, args);
  };
}
fixture.sourceBufferRanges = () => sourceBuffers.map(({ mime, sb }) => {
  const out: string[] = [];
  try {
    for (let i = 0; i < sb.buffered.length; i++) out.push(`${sb.buffered.start(i).toFixed(2)}-${sb.buffered.end(i).toFixed(2)}`);
  } catch {
    out.push("removed");
  }
  return `${mime.split(";")[0]} ${out.join(" ") || "empty"}`;
});

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
    barPct: Number(document.querySelector("[data-progress-fill]")?.getAttribute("data-progress-fill") ?? NaN),
    events: events.slice(sent),
  }, "*");
  sent = events.length;
}, 200);

// The runner can't reach into a player on another origin, so it asks: press
// these buttons, in order, as somebody would — the track menu's, say.
const buttonFor = (label: string) => {
  const all = [...document.querySelectorAll("button")];
  const text = (b: Element) => b.textContent?.trim() ?? "";
  return all.find((b) => b.title === label || text(b) === label) ?? all.find((b) => text(b).startsWith(label));
};
window.addEventListener("message", async (e: MessageEvent) => {
  const m = e.data as { kind?: string; press?: string[] };
  if (m?.kind !== "press" || !m.press) return;
  for (const label of m.press) {
    let button: HTMLButtonElement | undefined;
    for (let i = 0; i < 50 && !(button = buttonFor(label)); i++) await new Promise((r) => setTimeout(r, 100));
    events.push({ t: Date.now(), tag: "Fixture", msg: button ? "pressed" : "no such button", data: { label } });
    if (!button) return;
    button.click();
    await new Promise((r) => setTimeout(r, 200));
  }
});

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
  // The host starting another title from the player, as Next or the queue
  // does: the same player, handed another item.
  const [hostItem, setHostItem] = React.useState(firstItem);
  fixture.playTitle = (ratingKey: string) => setHostItem(titled(ratingKey));
  const roomItem = React.useMemo(() => (state.ratingKey ? titled(state.ratingKey) : null), [state.ratingKey]);
  if (!joined) {
    return (
      <button style={{ width: "100%", height: "100%", font: "600 24px system-ui", background: "#222", color: "#fff", border: 0 }}
        onClick={() => setJoined(true)}>Join</button>
    );
  }
  // A viewer opens the player when the room has something playing, and is
  // handed whatever the room moves on to, as the app does.
  if (!isHost && !roomItem) return <p style={{ color: "#aaa" }}>Viewer: waiting for the host to start…</p>;
  const item = isHost ? hostItem : roomItem!;
  if (stopped) return <p style={{ color: "#aaa" }}>Host: stopped</p>;
  return (
    <Player key={mount} item={item} isHost={isHost} selfUserId={user} subtitles={false}
      resumePosition={mount === 0 ? resume : undefined}
      sharePresenceDetails={false} onSharePresenceDetails={() => {}} onBack={() => {}}
      syncState={state} syncActions={actions} presentation="full" />
  );
}
createRoot(document.getElementById("root")!).render(<Room />);
