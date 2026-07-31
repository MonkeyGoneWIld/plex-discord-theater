import { useState } from "react";
import { ScrollShelf } from "./ScrollShelf";
import { authUrl, type Credit } from "../lib/api";
import { ShelfSkeleton } from "./ShelfSkeleton";

/** Diameter of a headshot. Plex's own cast row uses a similar circular crop. */
const AVATAR_PX = 150;

interface CastRowProps {
  cast?: Credit[];
  directors?: Credit[];
  /** Open a person's page. */
  onSelectPerson?: (person: Credit) => void;
  /** True while the metadata carrying these credits is still in flight, so the
   *  row holds its space instead of appearing from nothing. */
  loading?: boolean;
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

function CastAvatar({ person, onSelect }: { person: Credit; onSelect?: () => void }) {
  const [failed, setFailed] = useState(false);
  const show = person.thumb && !failed;
  const clickable = !!onSelect;
  return (
    <div
      style={clickable ? { ...styles.person, ...styles.personClickable } : styles.person}
      {...(clickable
        ? {
            role: "button",
            tabIndex: 0,
            onClick: onSelect,
            onKeyDown: (e: React.KeyboardEvent) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onSelect();
            },
            onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => {
              const img = e.currentTarget.firstElementChild as HTMLElement | null;
              if (img) img.style.borderColor = "rgba(229,160,13,0.75)";
            },
            onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => {
              const img = e.currentTarget.firstElementChild as HTMLElement | null;
              if (img) img.style.borderColor = "rgba(255,255,255,0.08)";
            },
          }
        : {})}
    >
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
 * Renders nothing at all when a title has no credits, which is the normal case
 * for a library item Plex never matched against its metadata agent.
 */
export function CastRow({ cast, directors, onSelectPerson, loading }: CastRowProps) {
  // The director leads, then the billed cast. Appending crew instead put them
  // past thirty actors — off the end of a row nobody scrolls that far — so the
  // one crew credit people actually look for was effectively missing. Writers
  // are deliberately not listed: on most titles they outnumber the useful
  // credits without being what anyone came to the row for.
  //
  // One entry per person, credits merged into a single label — someone who both
  // directed and appears in the film gets one disc, not two.
  const byName = new Map<string, Credit>();
  for (const p of [...(directors ?? []), ...(cast ?? [])]) {
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

  // Holding the space while the credits are in flight is the point — returning
  // null here and a full row a moment later is exactly the jolt this avoids.
  if (people.length === 0) return loading ? <ShelfSkeleton variant="cast" labelWidth={140} /> : null;

  return (
    <div style={styles.section}>
      <h3 style={styles.label}>Cast &amp; Crew</h3>
      {/* No scrollbar here — the edge chevrons are enough for a row this short,
          and the bar under the circles only added noise. */}
      <ScrollShelf rowStyle={styles.row} scrollbar={false}>
        {people.map((p, i) => (
          <CastAvatar
            key={`${p.name}-${p.role ?? i}`}
            person={p}
            onSelect={onSelectPerson ? () => onSelectPerson(p) : undefined}
          />
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
    // The page gutter, which shelfStyles.wrap no longer carries.
    padding: "0 24px",
  },
  // Side gutter matches the poster shelves so the first face lines up with the
  // first poster. The bottom stays tight: these cards have no hover glow to
  // leave room for, and this row draws no scrollbar under it.
  row: {
    display: "flex",
    gap: "18px",
    overflowX: "auto" as const,
    padding: "18px 24px 2px",
  },
  person: {
    flexShrink: 0,
    flexGrow: 0,
    width: `${AVATAR_PX}px`,
    textAlign: "center" as const,
  },
  personClickable: {
    cursor: "pointer",
  },
  avatar: {
    width: `${AVATAR_PX}px`,
    height: `${AVATAR_PX}px`,
    borderRadius: "50%",
    objectFit: "cover" as const,
    display: "block",
    background: "#1c1c1c",
    border: "1px solid rgba(255,255,255,0.08)",
    transition: "border-color 0.15s ease",
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
