// Manual/DOM fixture: npm run dev -w packages/client, then open
// /test/track-switcher.html. The audio and subtitle panel left open while the
// next episode starts: it lists the next episode's tracks, even when the
// first episode's details arrive after them. They used to land last and stay,
// and a track picked from them belonged to the episode before. The verdict is
// written above the panel. Not part of the production entry.
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

const json = (body: unknown, ms = 0) => new Promise<Response>((resolve) => setTimeout(() =>
  resolve(new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json" } })), ms));
const episode = (n: number) => ({
  ratingKey: String(n), type: "episode", title: `Episode ${n}`, partId: 100 + n,
  audioTracks: [{ id: 10 * n, title: `Episode ${n}'s audio`, selected: true }], subtitleTracks: [],
});
window.fetch = ((input: RequestInfo | URL) => {
  const p = new URL(input instanceof Request ? input.url : String(input), location.href).pathname;
  // The first episode's details are slow; the second's quick.
  if (p === "/api/plex/meta/1") return json(episode(1), 600);
  if (p === "/api/plex/meta/2") return json(episode(2), 50);
  return json({});
}) as typeof fetch;

const { TrackSwitcher } = await import("../src/components/TrackSwitcher");
const verdict = document.getElementById("verdict")!;

function Harness() {
  const [ratingKey, setRatingKey] = useState("1");
  // The next episode starts while the first's details are on their way.
  useEffect(() => {
    const t = setTimeout(() => setRatingKey("2"), 100);
    return () => clearTimeout(t);
  }, []);
  return (
    <TrackSwitcher
      ratingKey={ratingKey}
      onClose={() => {}}
      onTrackChange={() => {}}
      zoomMode="normal"
      onZoomModeChange={() => {}}
      quality={20000}
      onQualityChange={() => {}}
    />
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
setTimeout(() => {
  const text = document.getElementById("root")!.textContent ?? "";
  verdict.textContent = text.includes("Episode 2's audio") && !text.includes("Episode 1's audio")
    ? "PASS: the second episode's tracks, after both answers came"
    : `FAIL: ${text.includes("Episode 1's audio") ? "the first episode's tracks" : "no tracks"} after both answers came`;
}, 1200);
