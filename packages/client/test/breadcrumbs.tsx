// Manual/DOM fixture: npm run dev -w packages/client, then open
// /test/breadcrumbs.html. The header's trail at a few widths, fitted by
// useFittedTrail as App fits it — whole crumbs or none, never "Ho…". Not part
// of the production entry.
import { createRoot } from "react-dom/client";
import { useFittedTrail } from "../src/lib/useFittedTrail";

const nav: React.CSSProperties = {
  display: "flex", alignItems: "center", minHeight: "32px", gap: "2px", minWidth: 0, flex: 1,
  marginRight: "16px", overflow: "hidden",
};
const wrap: React.CSSProperties = { display: "flex", alignItems: "center", gap: "2px", flexShrink: 0 };
const crumb: React.CSSProperties = { fontSize: "14px", fontWeight: 600, padding: "6px 10px", whiteSpace: "nowrap" };

function Header({ width, trail }: { width: number; trail: string[] }) {
  const { shown, ref } = useFittedTrail(trail, trail.join("›"));
  return (
    <div data-width={width} style={{ width, display: "flex", alignItems: "center", border: "1px solid #333", marginBottom: 8, padding: "0 8px" }}>
      <nav ref={ref} style={nav} data-shown={shown.join(" › ")}>
        {shown.map((c, i) => (
          <span key={i} style={wrap}>
            {i > 0 && <span style={{ color: "#555", padding: "0 4px" }}>›</span>}
            <span style={{ ...crumb, color: i === shown.length - 1 && shown.length === trail.length ? "#e0e0e0" : "#e5a00d" }}>{c}</span>
          </span>
        ))}
      </nav>
      <span style={{ flexShrink: 0, color: "#888" }}>monkey26 (Host) · 2</span>
    </div>
  );
}

const trail = ["Home", "The Apothecary Diaries", "Season 1", "Episode 4: Chilly Apothecary"];
createRoot(document.getElementById("root")!).render(
  <>
    {[900, 640, 480, 400, 320, 240].map((w) => <Header key={w} width={w} trail={trail} />)}
    <Header width={330} trail={["Home", "The Apothecary Diaries", "Season 1"]} />
  </>,
);
