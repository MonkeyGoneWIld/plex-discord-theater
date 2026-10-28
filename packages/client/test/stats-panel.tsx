// Manual/DOM regression fixture: npm run dev -w packages/client, then open
// /test/stats-panel.html. Stats for nerds with every section open, on a
// desktop-sized player and a phone-sized one, with the Peers section full: two
// video peers, three players sharing extras, and every kind of extra moving
// both ways. On 28 October its lines ran past the panel and "0 players" broke
// in two. The Sync section's Start row and the Range line are at their longest
// too. The checks below measure what the browser laid out. Not part of the
// production entry.
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { StatsOverlay, type P2PStats } from "../src/components/StatsOverlay";
import { sideShare } from "../src/lib/sideShare";
import type { StreamNotes } from "../src/lib/streamNotes";
import type { SyncInfo } from "../src/lib/statsHealth";

const MB = 1024 * 1024;
localStorage.setItem("pdt:statsOpen", JSON.stringify(["playback", "video", "audio", "subtitles", "sync", "connection", "peers", "thumbnails"]));
// The largest each figure gets in practice, and the smallest.
const shared = sideShare as unknown as { stats: Record<string, { fromPlayers: number; fromBot: number; sent: number }>; players: Map<string, unknown> };
shared.stats.pgs = { fromPlayers: 1023.9 * MB, fromBot: 412 * 1024, sent: 3.2 * MB };
shared.stats.styled = { fromPlayers: 310 * 1024, fromBot: 1.1 * MB, sent: 0 };
shared.stats.previews = { fromPlayers: 0, fromBot: 21.8 * MB, sent: 999 };
for (const id of ["a1", "b2", "c3"]) shared.players.set(id, {});

const notes: StreamNotes = {
  video: "transcode", reason: "4K source (player max 1080p)", kbps: 12000, quality: null,
  audio: "transcode", audioFrom: "TrueHD 7.1", audioTo: "Opus 7.1", audioKbps: 512, audioReason: "The player can't play TrueHD",
  engine: "ffmpeg", encoder: "Intel Quick Sync (AV1), GPU decode", fallback: null,
  videoFrom: "HEVC Main 10 · 10-bit · Dolby Vision P7 · 3840×2160 · 23.976 fps", range: "HDR10",
};
const sync: SyncInfo = {
  role: "viewer", driftS: -0.04, rate: 1, waitingForRoom: false, roomPlaying: true,
  stalls: { count: 2, totalMs: 3100 },
  start: { tookS: 12.4, stops: 2, stoppedS: 3.1, watching: false },
};

function Panel({ width, height }: { width: number; height: number }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef(null);
  const p2pStatsRef = useRef<P2PStats>({ p2pBytes: 84.2 * MB, httpBytes: 412.6 * MB, uploadBytes: 61.3 * MB, peers: new Set(["x", "y"]) });
  return (
    <div className="stage" style={{ width, height }} data-stage={width}>
      <video ref={videoRef} muted playsInline style={{ width: "100%", height: "100%" }} />
      <StatsOverlay
        videoRef={videoRef} hlsRef={hlsRef} vpsRelay={false} sessionId="04ea211a-b1d7-4a1a-bc07-2fd584eef156"
        p2pStatsRef={p2pStatsRef} notes={notes} quality={0} visible onClose={() => {}}
        syncInfo={() => sync}
      />
    </div>
  );
}

/** Whatever overflows its box, or breaks a figure across lines. */
function measure(): string[] {
  const out: string[] = [];
  document.querySelectorAll<HTMLElement>("[data-stage]").forEach((stage) => {
    const w = stage.dataset.stage;
    const panel = stage.lastElementChild as HTMLElement;
    const box = panel.getBoundingClientRect();
    let worst = 0;
    panel.querySelectorAll<HTMLElement>("*").forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.width === 0) return;
      worst = Math.max(worst, r.right - box.right, box.left - r.left);
    });
    out.push(`${worst <= 0.5 ? "PASS" : "FAIL"} ${w}px: nothing past the panel's edge (worst ${worst.toFixed(1)}px)`);
    const table = panel.querySelector<HTMLElement>("[data-share-table]");
    if (!table) { out.push(`FAIL ${w}px: the Peers table is there`); return; }
    out.push(`${table.scrollWidth <= table.clientWidth ? "PASS" : "FAIL"} ${w}px: the table fits its column (${table.scrollWidth}/${table.clientWidth})`);
    // Every figure, and every line's value, on one line.
    const lineH = parseFloat(getComputedStyle(table).fontSize) * 1.6;
    const broken = [...table.children].flatMap((c) => c instanceof HTMLElement && c.style.display === "contents" ? [...c.children] : [c])
      .filter((c) => (c as HTMLElement).getBoundingClientRect().height > lineH && (c as HTMLElement).textContent!.length > 0)
      .map((c) => c.textContent);
    out.push(`${broken.length ? "FAIL" : "PASS"} ${w}px: no cell of the table broken over lines${broken.length ? ` (${broken.join(", ")})` : ""}`);
    const lines = [...panel.querySelectorAll<HTMLElement>("span")].filter((s) => /^\d+ players?$/.test(s.textContent ?? ""));
    const lh = lines.length ? parseFloat(getComputedStyle(lines[0]).lineHeight) || 16 : 16;
    const split = lines.filter((s) => s.getBoundingClientRect().height > lh * 1.5);
    out.push(`${lines.length && !split.length ? "PASS" : "FAIL"} ${w}px: "3 players" on one line`);
  });
  return out;
}

function Fixture() {
  const [results, setResults] = useState<string[]>([]);
  useEffect(() => { const t = setTimeout(() => setResults(measure()), 1500); return () => clearTimeout(t); }, []);
  const passed = results.filter((r) => r.startsWith("PASS")).length;
  return (
    <>
      <div className="results" data-results={results.length ? `${passed}/${results.length}` : "running"}>
        {results.length ? `${passed}/${results.length} pass\n${results.join("\n")}` : "measuring…"}
      </div>
      <Panel width={1280} height={980} />
      <Panel width={375} height={980} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
