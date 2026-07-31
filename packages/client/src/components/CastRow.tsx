import { useState } from "react";
import { ScrollShelf } from "./ScrollShelf";
import { authUrl, type Credit } from "../lib/api";

/** Diameter of a headshot. Plex's own cast row uses a similar circular crop. */
const AVATAR_PX = 150;

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
  // Director and writers lead, then the billed cast. Appending them instead put
  // them past thirty actors — off the end of a row nobody scrolls that far — so
  // the director, the one crew credit people actually look for, was effectively
  // missing. De-duplicated because a writer-director would otherwise appear
  // twice, adjacent, under two different job labels.
  // One entry per person, their credits merged into a single label
  // ("Director, Writer") rather than one disc each.
  const byName = new Map<string, Credit>();
  for (const p of [...(directors ?? []), ...(writers ?? []), ...(cast ?? [])]) {
    const existing = byName.get(p.name);
    if (!existing) {
      byName.set(p.name, { ...p });
      continue;
    }
    if (p.role && existing.role && !existing.role.includes(p.role)) {
      existing.role = `${existing.role}, ${p.role}`;
    } else if (p.role && !existing.role) {
      existing.role = p.role;
    }
    // Keep whichever source actually had a headshot.
    if (!existing.thumb && p.thumb) existing.thumb = p.thumb;
  }
  const people = [...byName.values()];
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
  // Horizontal padding stays at zero for the same reason as the poster shelves,
  // but the bottom is tight: these cards carry no hover glow to leave room for,
  // so the poster rows' 22px just left a gap before the scrollbar.
  row: {
    display: "flex",
    gap: "18px",
    overflowX: "auto" as const,
    padding: "18px 0 2px",
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
