import { useState } from "react";
import { ScrollShelf } from "./ScrollShelf";
import { authUrl, type Credit } from "../lib/api";

/** Diameter of a headshot. Plex's own cast row uses a similar circular crop. */
const AVATAR_PX = 110;

interface CastRowProps {
  cast?: Credit[];
  directors?: Credit[];
  writers?: Credit[];
}

/** Initials fallback for someone with no headshot — better than an empty disc. */
function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
}

function CastAvatar({ person }: { person: Credit }) {
  const [failed, setFailed] = useState(false);
  const show = person.thumb && !failed;
  return (
    <div style={styles.person}>
      {show ? (
        <img
          src={authUrl(person.thumb!)}
          alt={person.name}
          style={styles.avatar}
          loading="eager"
          onError={() => setFailed(true)}
        />
      ) : (
        <div style={{ ...styles.avatar, ...styles.avatarFallback }}>{initials(person.name)}</div>
      )}
      <div style={styles.name} title={person.name}>{person.name}</div>
      {person.role && <div style={styles.role} title={person.role}>{person.role}</div>}
    </div>
  );
}

/**
 * The detail pages' Cast & Crew row — circular headshots with the actor's name
 * and character beneath, laid out like Plex's own.
 *
 * Directors and writers are appended after the cast (labelled by job rather than
 * character) so the page carries the full credit block in one row instead of
 * three near-empty ones. Renders nothing at all when a title has no credits,
 * which is the normal case for a library item Plex never matched.
 */
export function CastRow({ cast, directors, writers }: CastRowProps) {
  // Crew after cast, de-duplicated: a writer-director would otherwise appear
  // twice in a row, adjacent, with two different job labels.
  const seen = new Set<string>();
  const people: Credit[] = [];
  for (const p of [...(cast ?? []), ...(directors ?? []), ...(writers ?? [])]) {
    const key = `${p.name}|${p.role ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    people.push(p);
  }
  if (people.length === 0) return null;

  return (
    <div style={styles.section}>
      <h3 style={styles.label}>Cast &amp; Crew</h3>
      <ScrollShelf rowStyle={styles.row}>
        {people.map((p, i) => (
          <CastAvatar key={`${p.name}-${p.role ?? i}`} person={p} />
        ))}
      </ScrollShelf>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  section: {
    paddingBottom: "8px",
  },
  label: {
    color: "#e0e0e0",
    fontSize: "20px",
    fontWeight: 700,
    marginBottom: 0,
    letterSpacing: "-0.01em",
  },
  // Matches the poster shelves: vertical-only padding, so the row's own overflow
  // box doesn't clip hover states and the cards keep their intended width.
  row: {
    display: "flex",
    gap: "18px",
    overflowX: "auto" as const,
    padding: "20px 0 22px",
  },
  person: {
    flexShrink: 0,
    flexGrow: 0,
    width: `${AVATAR_PX}px`,
    textAlign: "center" as const,
  },
  avatar: {
    width: `${AVATAR_PX}px`,
    height: `${AVATAR_PX}px`,
    borderRadius: "50%",
    objectFit: "cover" as const,
    display: "block",
    background: "#1c1c1c",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  avatarFallback: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#777",
    fontSize: "26px",
    fontWeight: 600,
    letterSpacing: "0.5px",
  },
  name: {
    marginTop: "10px",
    color: "#e8e8e8",
    fontSize: "13px",
    fontWeight: 600,
    lineHeight: 1.3,
    // Two lines then ellipsis, so a long name doesn't shift the row's height.
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden",
  },
  role: {
    marginTop: "3px",
    color: "#8a8a8a",
    fontSize: "12px",
    lineHeight: 1.3,
    display: "-webkit-box",
    WebkitLineClamp: 2,
    WebkitBoxOrient: "vertical" as const,
    overflow: "hidden",
  },
};
