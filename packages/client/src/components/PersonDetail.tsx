import { useEffect, useState } from "react";
import { authUrl, fetchPerson, type PersonDetail as Person, type PlexItem } from "../lib/api";
import { PosterShelf, shelfStyles } from "./PosterShelf";
import { SkeletonBlock } from "./SkeletonBlock";

interface PersonDetailProps {
  /** Plex tag id — the key this page is fetched by. */
  personId: number;
  /** Name from the credit that was clicked. Shown immediately (the same
   *  optimistic trick the title pages use) and used to match TMDB's record. */
  name: string;
  /** Headshot from the credit, so the photo is up before the fetch returns. */
  thumb?: string | null;
  onSelect: (item: PlexItem) => void;
  onBack: () => void;
}

/** Age in whole years, or null if the date is unusable. Uses the date of death
 *  when there is one, so a late actor's age reads as their age at death. */
function ageFrom(birthday: string | null, deathday: string | null): number | null {
  if (!birthday) return null;
  const born = new Date(birthday);
  if (Number.isNaN(born.getTime())) return null;
  const end = deathday ? new Date(deathday) : new Date();
  if (Number.isNaN(end.getTime())) return null;
  let age = end.getFullYear() - born.getFullYear();
  const m = end.getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && end.getDate() < born.getDate())) age--;
  return age >= 0 && age < 130 ? age : null;
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * A cast or crew member's page: their photo and biography, then everything the
 * library holds that they worked on, movies and shows kept apart.
 *
 * The filmography is drawn from Plex by tag, so it only ever lists titles that
 * are actually here — there's no "not in library" state to handle. The prose and
 * dates come from TMDB and are optional; without them the page is still a useful
 * index of their work.
 */
export function PersonDetail({ personId, name, thumb, onSelect, onBack }: PersonDetailProps) {
  const [person, setPerson] = useState<Person | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    setImgFailed(false);
    fetchPerson(personId, name)
      .then((p) => { if (!cancelled) setPerson(p); })
      .catch(() => { if (!cancelled) setFailed(true); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [personId, name]);

  // Name and photo come from the credit that was clicked, so the page has a
  // subject from the first frame — same reasoning as the title pages.
  const dName = person?.name ?? name;
  const photo = person?.thumb ?? thumb ?? null;
  const age = ageFrom(person?.birthday ?? null, person?.deathday ?? null);
  const born = formatDate(person?.birthday ?? null);
  const died = formatDate(person?.deathday ?? null);

  return (
    <div style={styles.page}>
      <button onClick={onBack} style={styles.backBtn}>
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M12.5 15L7.5 10L12.5 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
        Back
      </button>

      <div style={styles.header}>
        {photo && !imgFailed ? (
          <img src={authUrl(photo)} alt={dName} style={styles.photo} onError={() => setImgFailed(true)} />
        ) : (
          <div style={{ ...styles.photo, ...styles.photoPlaceholder }}>No photo</div>
        )}

        <div style={styles.info}>
          <h1 style={styles.name}>{dName}</h1>
          {person?.knownFor && <div style={styles.role}>{person.knownFor}</div>}

          <div style={styles.facts}>
            {loading && !person ? (
              <SkeletonBlock width={220} height={15} />
            ) : (
              <>
                {born && (
                  <div style={styles.fact}>
                    <span style={styles.factKey}>Born</span>
                    <span>
                      {born}
                      {age != null && !died ? ` (${age} years)` : ""}
                    </span>
                  </div>
                )}
                {died && (
                  <div style={styles.fact}>
                    <span style={styles.factKey}>Died</span>
                    <span>{died}{age != null ? ` (aged ${age})` : ""}</span>
                  </div>
                )}
                {person?.placeOfBirth && (
                  <div style={styles.fact}>
                    <span style={styles.factKey}>From</span>
                    <span>{person.placeOfBirth}</span>
                  </div>
                )}
              </>
            )}
          </div>

          {loading && !person ? (
            <div style={styles.bioSkeleton}>
              <SkeletonBlock width="100%" height={14} />
              <SkeletonBlock width="96%" height={14} />
              <SkeletonBlock width="70%" height={14} />
            </div>
          ) : person?.biography ? (
            <p style={styles.bio}>{person.biography}</p>
          ) : failed ? (
            <p style={styles.muted}>Couldn't load this person's details.</p>
          ) : null}
        </div>
      </div>

      {/* Their work, as far as the library goes. Movies and shows are kept in
          separate rows rather than one mixed shelf. */}
      <div style={shelfStyles.wrap}>
        {loading && !person ? (
          <>
            <SkeletonBlock width={140} height={20} />
            <div style={{ display: "flex", gap: "14px", padding: "20px 0 22px" }}>
              {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                <div key={i} style={{ flexShrink: 0, width: 182 }}>
                  <SkeletonBlock width={182} height={273} borderRadius={10} />
                  <SkeletonBlock width="80%" height={13} style={{ marginTop: 8 }} />
                </div>
              ))}
            </div>
          </>
        ) : (
          <>
            {person && person.movies.length > 0 && (
              <PosterShelf title="Movies" items={person.movies} onSelect={onSelect} />
            )}
            {person && person.shows.length > 0 && (
              <PosterShelf title="TV Shows" items={person.shows} onSelect={onSelect} />
            )}
            {person && person.movies.length === 0 && person.shows.length === 0 && (
              <p style={styles.muted}>Nothing in your library credits this person.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    position: "relative",
    minHeight: "100vh",
    background: "#0d0d0d",
  },
  backBtn: {
    position: "relative",
    zIndex: 10,
    margin: "20px 0 0 24px",
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    padding: "8px 16px 8px 10px",
    borderRadius: "8px",
    border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(255,255,255,0.06)",
    color: "#ddd",
    fontSize: "14px",
    fontFamily: "inherit",
    cursor: "pointer",
  },
  header: {
    position: "relative",
    zIndex: 10,
    display: "flex",
    gap: "32px",
    padding: "28px 24px 8px",
    maxWidth: "1100px",
    flexWrap: "wrap",
  },
  photo: {
    width: "240px",
    aspectRatio: "2 / 3",
    objectFit: "cover",
    borderRadius: "10px",
    flexShrink: 0,
    background: "#1a1a1a",
    border: "1px solid rgba(255,255,255,0.07)",
  },
  photoPlaceholder: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#666",
    fontSize: "13px",
  },
  info: {
    flex: 1,
    minWidth: "280px",
  },
  name: {
    color: "#fff",
    fontSize: "36px",
    fontWeight: 800,
    letterSpacing: "-0.02em",
    margin: 0,
    lineHeight: 1.1,
  },
  role: {
    color: "#e5a00d",
    fontSize: "15px",
    fontWeight: 600,
    marginTop: "6px",
  },
  facts: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    marginTop: "20px",
    minHeight: "22px",
  },
  fact: {
    display: "flex",
    gap: "14px",
    fontSize: "14px",
    color: "#ccc",
  },
  factKey: {
    color: "#8a8a8a",
    minWidth: "46px",
  },
  bio: {
    color: "#bdbdbd",
    fontSize: "15px",
    lineHeight: 1.65,
    marginTop: "20px",
    maxWidth: "70ch",
  },
  bioSkeleton: {
    display: "flex",
    flexDirection: "column",
    gap: "9px",
    marginTop: "22px",
    maxWidth: "70ch",
  },
  muted: {
    color: "#777",
    fontSize: "14px",
    marginTop: "16px",
  },
};
