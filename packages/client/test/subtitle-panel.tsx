// Manual/DOM fixture: npm run dev -w packages/client, then open
// /test/subtitle-panel.html. Mounts the real SubtitleLayer, subtitle settings
// panel and control bar over a stand-in video — no Plex, no stream — to see
// lines drawn together, signs at the top, the viewer's own look, and the scrub
// bar through a seek restart. Not part of the production entry.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { SubtitleLayer } from "../src/components/SubtitleLayer";
import { SubtitleSettings } from "../src/components/SubtitleOffset";
import { Controls } from "../src/components/Controls";

const RUNTIME_S = 6544; // The Sheep Detectives: 1:49:04.
// In start order, as the server sends them.
const cues = [
  { start: 0, end: 4, text: "Would you like\nto say a few words?" },
  { start: 1, end: 9, text: "YOUR LIE IN APRIL", top: true },
  { start: 2, end: 6, text: "No.", italic: true },
  { start: 6, end: 9, text: "A line on its own." },
];
window.fetch = async (input) => {
  const url = String(input);
  if (url.includes("/api/plex/subtitles/")) return Response.json({ cues, complete: true });
  return Response.json({});
};

/** The element's clock and buffer, as the fixture sets them. */
const fake = { time: 1, duration: 1480, buffered: [[1464, 1475]] as Array<[number, number]> };

function Fixture() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [time, setTime] = useState(fake.time);
  const [restartingTo, setRestartingTo] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    const el = videoRef.current!;
    Object.defineProperty(el, "currentTime", { configurable: true, get: () => fake.time, set: (v: number) => { fake.time = v; } });
    Object.defineProperty(el, "duration", { configurable: true, get: () => fake.duration });
    Object.defineProperty(el, "videoWidth", { configurable: true, get: () => 1920 });
    Object.defineProperty(el, "videoHeight", { configurable: true, get: () => 960 });
    Object.defineProperty(el, "paused", { configurable: true, get: () => true });
    Object.defineProperty(el, "buffered", {
      configurable: true,
      get: () => ({ length: fake.buffered.length, start: (i: number) => fake.buffered[i][0], end: (i: number) => fake.buffered[i][1] }),
    });
    el.dispatchEvent(new Event("loadedmetadata"));
    el.dispatchEvent(new Event("durationchange"));
  }, []);

  const at = (s: number) => {
    fake.time = s;
    setTime(s);
    videoRef.current?.dispatchEvent(new Event("timeupdate"));
  };

  return (
    <div>
      <div className="tools">
        <button onClick={() => at(1)}>t = 1s (one line + sign)</button>
        <button onClick={() => at(3)}>t = 3s (two lines + sign)</button>
        <button onClick={() => at(7)}>t = 7s</button>
        <button data-seek onClick={() => { at(0); setRestartingTo(1464.72); }}>Seek restart to 24:24 (copy playlist 24:40 long)</button>
        <button onClick={() => { setRestartingTo(null); at(1467.7); }}>Seek landed</button>
        <span id="time">t={time}</span>
      </div>
      <div id="player" style={{ position: "relative", width: "100%", maxWidth: 960, aspectRatio: "16 / 9", background: "#000", overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0 }}>
          <div style={{ position: "absolute", inset: 0 }}>
            <video ref={videoRef} style={{ width: "100%", height: "100%", objectFit: "contain", background: "linear-gradient(135deg,#23413a,#4d6b4e 50%,#20262e)" }} />
          </div>
        </div>
        <SubtitleLayer streamId={1} ratingKey="1" videoRef={videoRef} offsetMs={offset} />
        <Controls
          videoRef={videoRef}
          isHost
          title="The Sheep Detectives (2026)"
          onBack={() => {}}
          runtimeS={RUNTIME_S}
          restartingTo={restartingTo}
          onOpenSubtitleTiming={() => {}}
          subtitleTimingOpen
        />
        <div style={{ position: "absolute", right: 12, bottom: 90, zIndex: 40 }}>
          <SubtitleSettings offsetMs={offset} onChange={setOffset} onClose={() => {}} />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
