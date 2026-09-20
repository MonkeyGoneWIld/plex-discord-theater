// Manual/DOM regression fixture: npm run dev -w packages/client, then open
// /test/pip-interactions.html. This mounts the actual Player without Plex,
// Discord or streaming traffic. It is not included in the production entry.
import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player } from "../src/components/Player";
import type { PlexItem } from "../src/lib/api";
import type { SyncState } from "../src/hooks/useSync";

const item: PlexItem = { ratingKey: "pip-fixture", title: "A quiet afternoon", type: "episode", thumb: null, parentIndex: 1, index: 1 };
const artwork = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 180"><rect width="320" height="180" fill="#304c59"/><circle cx="240" cy="55" r="25" fill="#e5a00d"/><path d="M0 180 95 65 180 150 230 110 320 180" fill="#59755c"/></svg>')}#still`;
const next = { ...item, ratingKey: "pip-fixture-next", title: "The next chapter", index: 2, showTitle: "Sample series", thumb: artwork };
window.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/config")) return new Promise<Response>(() => {}); // Keep the streaming pipeline idle.
  if (url.includes("/siblings/")) return Response.json({ episode: true, prev: null, next });
  if (url.includes("/meta/")) return Response.json({ ...item, partId: null, markers: [], genres: [], versions: [], audioTracks: [], subtitleTracks: [] });
  return Response.json({});
};
const pause = (ms = 400) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const check = (condition: unknown, message: string) => { if (!condition) throw new Error(message); };
const closeEnough = (a: number, b: number) => Math.abs(a - b) < 2;
const surface = () => document.querySelector<HTMLDivElement>("[data-presentation]")!;
const rect = () => surface().getBoundingClientRect();
const video = () => surface().querySelector("video")!;
const dragTarget = () => surface().querySelector("img") ?? video();
function button(label: string) {
  const found = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === label || el.getAttribute("aria-label") === label);
  if (!found) throw new Error(`Missing button: ${label}`);
  return found;
}
function pointer(type: string, x: number, y: number) {
  // Synthetic PointerEvents aren't active OS pointers. Stub just capture for
  // this test sequence; manual browser drags continue to use native capture.
  surface().setPointerCapture = () => {};
  dragTarget().dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 9, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1, clientX: x, clientY: y }));
}
function touch(type: string, points: number[][]) {
  const touches = points.map(([clientX, clientY], identifier) => new Touch({ identifier, target: dragTarget(), clientX, clientY }));
  dragTarget().dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches, targetTouches: touches, changedTouches: touches }));
}
async function dragTo(left: number, top: number, cancel = false, mobile = false) {
  const before = rect();
  const x = before.left + before.width / 2, y = before.top + before.height / 2;
  const dx = left - before.left, dy = top - before.top;
  if (mobile) touch("touchstart", [[x, y]]); else pointer("pointerdown", x, y);
  await frame();
  for (let step = 1; step <= 6; step++) {
    const point = [x + dx * step / 6, y + dy * step / 6];
    if (mobile) touch("touchmove", [point]); else pointer("pointermove", point[0], point[1]);
    await pause(25);
  }
  if (!cancel) await pause(130); // Deliberate placement, not a fling.
  if (mobile) touch(cancel ? "touchcancel" : "touchend", []);
  else pointer(cancel ? "pointercancel" : "pointerup", x + dx, y + dy);
  await pause();
}

function Fixture() {
  const [generation, setGeneration] = useState(0);
  const [mode, setMode] = useState<"full" | "pip">("pip");
  const [host, setHost] = useState(false);
  const [closed, setClosed] = useState(false);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<string[]>([]);
  const [geometry, setGeometry] = useState("");
  const restore = useCallback(() => setMode("full"), []);
  const minimize = useCallback(() => setMode("pip"), []);
  const leave = useCallback(() => setClosed(true), []);
  const reset = useCallback((asHost = false, presentation: "full" | "pip" = "pip") => {
    setHost(asHost); setMode(presentation); setClosed(false); setGeneration((n) => n + 1);
  }, []);
  useEffect(() => {
    let id: number;
    const update = () => {
      const el = surface();
      const box = el?.getBoundingClientRect();
      setGeometry(box ? `${el.dataset.presentation}: x ${box.x.toFixed(1)}, y ${box.y.toFixed(1)}, w ${box.width.toFixed(1)}, h ${box.height.toFixed(1)}` : "Player closed");
      id = requestAnimationFrame(update);
    };
    update();
    return () => cancelAnimationFrame(id);
  }, []);
  async function run() {
    setRunning(true); setResults([]);
    const pass = (text: string) => setResults((lines) => [...lines, `PASS ${text}`]);
    try {
      reset(); await pause();
      check(!document.querySelector('[aria-label="Minimize player"]'), "Minimize arrow still exists");
      check(closeEnough(rect().right, innerWidth - 18) && closeEnough(rect().bottom, innerHeight - 18), "Initial bottom-right placement");
      pass("Every PiP entry starts bottom-right");
      for (const edge of ["left", "top", "right", "bottom"]) {
        const size = rect();
        const x = edge === "left" ? 18 : edge === "right" ? innerWidth - size.width - 18 : (innerWidth - size.width) / 2;
        const y = edge === "top" ? 18 : edge === "bottom" ? innerHeight - size.height - 18 : (innerHeight - size.height) / 2;
        await dragTo(x, y);
        check(closeEnough(rect().x, x) && closeEnough(rect().y, y), `Cannot place at ${edge} midpoint`);
        const before = rect();
        pointer("pointerdown", x + size.width / 2, y + size.height / 2); await frame();
        pointer("pointermove", x + size.width / 2 + 2, y + size.height / 2 + 2); await frame();
        pointer("pointerup", x + size.width / 2 + 2, y + size.height / 2 + 2); await pause();
        check(closeEnough(rect().x, before.x) && closeEnough(rect().y, before.y), `Tiny movement shifted ${edge}`);
        pass(`${edge}: deliberate placement and tiny touches stay put`);
      }
      let size = rect();
      await dragTo(innerWidth - size.width - 18, (innerHeight - size.height) / 2, true);
      const beforeCancel = rect();
      touch("touchstart", [[beforeCancel.x + 80, beforeCancel.y + 70]]); await frame(); touch("touchcancel", []); await pause();
      check(surface().dataset.presentation === "pip", "Canceled touch restored player");
      check(closeEnough(rect().y, beforeCancel.y), "Cancellation caused a throw");
      pass("Canceled gestures neither fling nor restore");
      let moving = rect();
      let cx = moving.x + moving.width / 2, cy = moving.y + moving.height / 2;
      pointer("pointerdown", cx, cy); await frame();
      pointer("pointermove", cx - 65, cy); await frame();
      pointer("pointercancel", cx - 65, cy); await pause(35);
      moving = rect(); cx = moving.x + moving.width / 2; cy = moving.y + moving.height / 2;
      pointer("pointerdown", cx, cy); await frame();
      check(closeEnough(rect().x, moving.x), "Grabbing an animation jumped to its destination");
      pointer("pointerup", cx, cy); await pause();
      check(closeEnough(rect().right, innerWidth - 18), "A click during settling stranded PiP away from border");
      pass("Re-grabbing an animation stays under the pointer; a click resumes docking");
      await dragTo(18, (innerHeight - size.height) / 2, false, true);
      check(closeEnough(rect().left, 18), "Touch dragging failed");
      pass("Touch drags work at desktop/tablet viewport sizes too");
      const box = rect();
      const pair = [[box.x + 30, box.y + 50], [box.x + 130, box.y + 50]];
      touch("touchstart", pair); await frame(); touch("touchmove", pair); await frame(); touch("touchend", []); await pause();
      check(surface().dataset.presentation === "pip", "Stationary pinch restored player");
      pass("A pinch with no size change never restores the player");
      const originalTransform = video().style.transform;
      touch("touchstart", pair); await frame();
      touch("touchmove", [[box.x + 20, box.y + 50], [box.x + 145, box.y + 50]]); await frame();
      touch("touchend", []); await pause();
      check(rect().width > box.width && video().style.transform === originalTransform, "Pinch changed crop instead of PiP size");
      touch("touchstart", pair); await frame();
      touch("touchmove", [[box.x, box.y + 50], [box.x + 2000, box.y + 50]]); await frame(); touch("touchend", []); await pause();
      const maxWidth = rect().width;
      touch("touchstart", pair); await frame();
      touch("touchmove", [[box.x, box.y + 50], [box.x + 2000, box.y + 50]]); await frame(); touch("touchend", []); await pause();
      check(surface().dataset.presentation === "pip" && closeEnough(rect().width, maxWidth), "Pinch at maximum restored or exceeded size limit");
      pass("Pinching resizes PiP, preserves crop, and handles size limits");
      reset(); await pause();
      const ended = video(); ended.dispatchEvent(new Event("ended")); await pause();
      check(surface().textContent?.includes("Next episode"), "No end card");
      const imageDrag = new DragEvent("dragstart", { bubbles: true, cancelable: true });
      dragTarget().dispatchEvent(imageDrag);
      check(imageDrag.defaultPrevented, "End-card artwork can start native image drag");
      size = rect();
      await dragTo(innerWidth - size.width - 18, (innerHeight - size.height) / 2);
      check(closeEnough(rect().right, innerWidth - 18), "Ended PiP cannot move");
      button("Close picture in picture").click(); await pause();
      check(!surface(), "Viewer close didn't leave");
      pass("Ended PiP remains movable and closable");
      reset(false, "full"); await pause();
      const originalVideo = video();
      button("Back").click(); await pause();
      check(surface().dataset.presentation === "pip" && video() === originalVideo, "Viewer Back did not preserve player in PiP");
      pass("Viewer Back minimizes the same player; no minimize arrow");
      const tapBox = rect();
      touch("touchstart", [[tapBox.x + 80, tapBox.y + 70]]); await frame(); touch("touchend", []); await pause();
      check(surface().dataset.presentation === "full" && video() === originalVideo, "Touch tap did not restore the same player");
      button("Back").click(); await pause();
      pass("Touch tap restores; Back returns to bottom-right PiP");
      reset(true, "full"); await pause();
      button("Back").click(); await pause();
      check(document.body.textContent?.includes("End stream?"), "Host Back lacked warning");
      button("Use picture in picture").click(); await pause();
      check(surface().dataset.presentation === "pip", "Host PiP choice failed");
      // Make desktop hover controls visible without a real pointer.
      surface().dispatchEvent(new MouseEvent("mouseover", { bubbles: true })); await frame();
      button("Close picture in picture").click(); await pause();
      check(!document.body.textContent?.includes("Use picture in picture"), "PiP close warning incorrectly offers PiP");
      button("End stream").click(); await pause();
      check(!surface(), "Confirmed host close didn't leave");
      pass("Host Back offers PiP; PiP X confirms once and ends stream");
    } catch (error) {
      setResults((lines) => [...lines, `FAIL ${String(error)}`]);
    } finally {
      reset(); setRunning(false);
    }
  }
  const state = { participants: host ? [{ userId: "other", username: "Other viewer" }] : [], queue: [], commandSeq: 0, stateSeq: 0, seekSeq: 0, connected: false } as unknown as SyncState;
  return <>
    <main>
      <h1>PiP interaction checks</h1>
      <p>Real player, isolated local data. Drag the picture to any border, click or make a small adjustment, and double-click to restore. Use Back to return to PiP.</p>
      <div className="tools">
        <button disabled={running} onClick={() => reset()}>Reset viewer PiP</button>
        <button disabled={running} onClick={() => reset(true)}>Reset host PiP</button>
        <button disabled={running} onClick={() => video()?.dispatchEvent(new Event("ended"))}>End episode</button>
        <button disabled={running} onClick={run}>{running ? "Checking…" : "Run interaction checks"}</button>
      </div>
      <pre aria-live="polite">{results.join("\n")}</pre>
    </main>
    <div id="rect">{geometry}</div>
    {!closed && <Player key={generation} item={item} isHost={host} selfUserId="self" subtitles={false} sharePresenceDetails={false} onSharePresenceDetails={() => {}} onBack={leave} syncState={state} presentation={mode} onMinimize={minimize} onRestore={restore} />}
  </>;
}
createRoot(document.getElementById("root")!).render(<Fixture />);
