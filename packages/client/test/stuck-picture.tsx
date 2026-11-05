// DOM fixture for a decoder that has stopped giving pictures. Run
//   node packages/client/test/media-errors-server.mjs
// and npm run dev -w packages/client, then open /test/stuck-picture.html.
// This mounts the actual Player as host over real hls.js, on the stream
// server's clean stream, with the video element made to act as the laptop's
// of 5 November did: the video comes in, and no picture comes out of it
// (readyState held at HAVE_METADATA, no frames shown). Not in the production
// entry.
//
// What it guards against: the player sat on its loading screen forever,
// rebuilding the stream every 15 s, while only a restart of Discord could get
// the picture back (lib/stuckPicture). On H.264, with nothing lighter to ask
// for, the viewer is now told so.
import React from "react";
import { createRoot } from "react-dom/client";
import { Player } from "../src/components/Player";
import type { PlexItem } from "../src/lib/api";
import type { SyncActions, SyncState } from "../src/hooks/useSync";

const STREAMS = "http://localhost:3999";
const open = XMLHttpRequest.prototype.open as (this: XMLHttpRequest, ...args: unknown[]) => void;
XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
  const m = String(url).match(/\/api\/plex\/hls\/([^/]+)\/[^/]+\/(.+)$/);
  open.call(this, method, m ? `${STREAMS}/${m[1]}/${m[2]}` : url, ...rest);
} as typeof XMLHttpRequest.prototype.open;

const episode: PlexItem = {
  ratingKey: "clean", title: "Episode One", type: "episode", thumb: null,
  showTitle: "Test Show", parentIndex: 1, index: 1, duration: 120_000,
};
window.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/api/plex/config")) return Response.json({ vpsRelay: true });
  if (url.includes("/played-threshold")) return Response.json({ threshold: 0.9 });
  if (url.includes("/meta/")) return Response.json({ ...episode, partId: null, markers: [], genres: [], versions: [], audioTracks: [], subtitleTracks: [] });
  if (url.includes("/siblings/")) return Response.json({ episode: true, prev: null, next: null });
  return Response.json({});
};

// The stopped decoder: whatever comes in, no picture.
const readyState = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "readyState")!;
Object.defineProperty(HTMLMediaElement.prototype, "readyState", {
  configurable: true,
  get(this: HTMLMediaElement) { return Math.min(1, readyState.get!.call(this) as number); },
});
HTMLVideoElement.prototype.getVideoPlaybackQuality = function () {
  return { totalVideoFrames: 0, droppedVideoFrames: 0, corruptedVideoFrames: 0, creationTime: performance.now() } as VideoPlaybackQuality;
};

const syncActions = new Proxy({}, { get: () => () => {} }) as unknown as SyncActions;
const state = { participants: [], queue: [], commandSeq: 0, stateSeq: 0, seekSeq: 0, connected: false } as unknown as SyncState;

createRoot(document.getElementById("root")!).render(
  <Player item={episode} isHost selfUserId="self" subtitles={false}
    sharePresenceDetails={false} onSharePresenceDetails={() => {}} onBack={() => {}}
    syncState={state} syncActions={syncActions} presentation="full" />,
);

const startedAt = performance.now();
const results = document.getElementById("results")!;
const timer = setInterval(() => {
  const v = document.querySelector("video");
  const s = ((performance.now() - startedAt) / 1000).toFixed(0);
  let ahead = 0;
  if (v) for (let i = 0; i < v.buffered.length; i++) if (v.buffered.start(i) <= v.currentTime + 0.1 && v.buffered.end(i) > v.currentTime) ahead = v.buffered.end(i) - v.currentTime;
  if (document.body.innerText.includes("The picture has stopped on this device")) {
    results.textContent = `PASS told to restart after ${s} s (in hand ${ahead.toFixed(1)} s)`;
    clearInterval(timer);
  } else if (performance.now() - startedAt > 40_000) {
    results.textContent = `FAIL not told after ${s} s (in hand ${ahead.toFixed(1)} s)`;
    clearInterval(timer);
  } else results.textContent = `waiting ${s} s, in hand ${ahead.toFixed(1)} s`;
}, 500);
