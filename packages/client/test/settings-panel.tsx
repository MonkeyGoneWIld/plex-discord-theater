// Manual/DOM fixture: npm run dev -w packages/client, then open
// /test/settings-panel.html. The header's right-hand pills, at the size they
// share, and the Settings panel they open — no Discord, no server. Not part of
// the production entry.
import { createRoot } from "react-dom/client";
import { InviteButton } from "../src/components/InviteButton";
import { PlexAccountButton } from "../src/components/PlexAccountButton";
import { SettingsPanel } from "../src/components/SettingsPanel";
import { HEADER_PILL, QUIET_SURFACE } from "../src/lib/surface";

window.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes("/api/history/settings")) {
    return Response.json({ saveMode: init?.method === "PUT" ? JSON.parse(String(init.body)).saveMode : "all" });
  }
  if (url.includes("plex-account")) return Response.json({ linked: false });
  return Response.json({});
};

// The roster pill as App draws it.
const people: React.CSSProperties = {
  ...HEADER_PILL, display: "inline-flex", alignItems: "center", gap: "5px", borderRadius: "999px",
  border: "1px solid rgba(229,160,13,0.35)", background: "rgba(229,160,13,0.08)", color: "#e5a00d", fontWeight: 600,
};
const gear: React.CSSProperties = {
  ...HEADER_PILL, ...QUIET_SURFACE, width: "26px", padding: 0, display: "inline-flex", alignItems: "center",
  justifyContent: "center", borderRadius: "999px", color: "#9a9a9a",
};

function Fixture() {
  return (
    <>
      <div id="header" style={{ display: "flex", alignItems: "center", gap: "10px", fontSize: 13, color: "#888", padding: 12 }}>
        <PlexAccountButton onHistoryChanged={() => {}} onOpenExternalLink={() => {}} />
        <InviteButton onInvite={async () => "unavailable" as never} />
        <span>monkey26 (Host)</span>
        <button style={people}>1</button>
        <button style={gear} aria-label="Settings">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M3 5h8M15 5h2M3 10h2M9 10h8M3 15h6M13 15h4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            <circle cx="13" cy="5" r="2" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="7" cy="10" r="2" stroke="currentColor" strokeWidth="1.6" />
            <circle cx="11" cy="15" r="2" stroke="currentColor" strokeWidth="1.6" />
          </svg>
        </button>
      </div>
      <SettingsPanel onClose={() => {}} />
    </>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
