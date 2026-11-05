// DOM fixture for a picture subtitle whose request fails for a moment. Run
//   npm run dev -w packages/client
// and open /test/picture-subtitle-retry.html?fail=status (or piece, or 404).
// This mounts the actual PictureSubtitleLayer over a stubbed fetch. Not in the
// production entry.
//
// What it guards against: one "Failed to fetch" through Discord's proxy had
// the subtitle burned into a re-encode (2 Guns, 5 November). Now a request
// that failed for the moment is made again (lib/retryLater); one the server
// refused still has it burned in at once.
import React, { useRef } from "react";
import { createRoot } from "react-dom/client";
import { PictureSubtitleLayer } from "../src/components/PictureSubtitleLayer";

const failing = new URLSearchParams(location.search).get("fail") ?? "status";
const counts = { status: 0, piece: 0, burnedIn: 0 };
const real = window.fetch;
window.fetch = async (input, init) => {
  const url = String(input instanceof Request ? input.url : input);
  if (/\/api\/plex\/pgs\/1\/0\?/.test(url)) {
    counts.piece++;
    if (failing === "piece" && counts.piece === 1) throw new TypeError("Failed to fetch");
    if (failing === "404") return new Response("not found", { status: 404 });
    return new Response(new Uint8Array([0x50, 0x47, 0, 0]));
  }
  if (/\/api\/plex\/pgs\/1\?/.test(url)) {
    counts.status++;
    if (failing === "status" && counts.status === 1) throw new TypeError("Failed to fetch");
    return Response.json({ pieces: [{ id: 0, fromS: 0, toS: null, bytes: 4, done: true }], done: true, failed: null, v: null });
  }
  if (url.includes("/api/")) return Response.json({});
  return real(input, init);
};

function Fixture() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const statusRef = useRef<import("../src/lib/subtitleStatus").SubtitleLoadStatus | null>(null);
  (window as unknown as { subtitleStatus: typeof statusRef }).subtitleStatus = statusRef;
  return (
    <div style={{ position: "relative", width: 640, height: 360 }}>
      <video ref={(v) => { videoRef.current = v; if (v) v.currentTime = 5; }} width={640} height={360} muted />
      <PictureSubtitleLayer
        streamId={1} ratingKey="1" videoRef={videoRef} offsetMs={0} statusRef={statusRef}
        onUnavailable={() => { counts.burnedIn++; }}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
setTimeout(() => {
  const state = (window as unknown as { subtitleStatus: { current: { state: string } | null } }).subtitleStatus.current?.state ?? "none";
  document.getElementById("results")!.textContent =
    `fail=${failing} burnedIn=${counts.burnedIn} state=${state} statusAsks=${counts.status} pieceReads=${counts.piece}`;
}, 6_000);
