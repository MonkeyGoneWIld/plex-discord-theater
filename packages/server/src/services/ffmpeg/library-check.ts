/**
 * Whether the library is where the engine looks for it, said once at startup.
 *
 * A MEDIA_PATH_MAP that is wrong, or a share that isn't mounted, leaves every
 * stream reading through Plex's file endpoint (still the engine's, but over
 * HTTP, and no sidecar or font can be found that way) with nothing to say so
 * but a "source: plex" on each log line. So a few files of each library are
 * looked for on the mount, and the answer goes in the [Config] lines:
 * "Movies 10/10 readable, TV Shows 0/10 — check MEDIA_PATH_MAP".
 */
import { localPath, readable } from "./config.js";

/** Files looked for in each library. */
const SAMPLE = 10;

interface Section { key: string; title: string; type: string }
interface Item { Media?: Array<{ Part?: Array<{ file?: string }> }> }

export interface LibraryReadability {
  title: string;
  readable: number;
  looked: number;
  /** The first file that wasn't there, as this container would see it. */
  missing: string | null;
}

/** Each movie and TV library's sampled files, found or not. */
export async function checkLibraryPaths(
  plexJSON: <T>(path: string) => Promise<T>,
): Promise<LibraryReadability[]> {
  const sections = await plexJSON<{ MediaContainer: { Directory?: Section[] } }>("/library/sections");
  const out: LibraryReadability[] = [];
  for (const section of sections.MediaContainer.Directory ?? []) {
    // Movies are items of type 1, episodes of type 4.
    const type = section.type === "movie" ? 1 : section.type === "show" ? 4 : null;
    if (type === null) continue;
    const items = await plexJSON<{ MediaContainer: { Metadata?: Item[] } }>(
      `/library/sections/${section.key}/all?type=${type}&X-Plex-Container-Start=0&X-Plex-Container-Size=${SAMPLE}`,
    ).catch(() => null);
    const files = (items?.MediaContainer.Metadata ?? [])
      .map((m) => m.Media?.[0]?.Part?.[0]?.file)
      .filter((f): f is string => !!f);
    let found = 0;
    let missing: string | null = null;
    for (const file of files) {
      const local = localPath(file);
      if (readable(local)) found++;
      else missing ??= local;
    }
    out.push({ title: section.title, readable: found, looked: files.length, missing });
  }
  return out;
}

/** The [Config] line's words for it. */
export function libraryReadabilityText(libraries: LibraryReadability[]): string {
  if (!libraries.length) return "no movie or TV libraries to look in";
  const parts = libraries.map((l) => `${l.title} ${l.readable}/${l.looked} readable`);
  const short = libraries.filter((l) => l.looked > 0 && l.readable < l.looked);
  if (!short.length) return parts.join(", ");
  const example = short.find((l) => l.missing)?.missing;
  return `${parts.join(", ")} — check MEDIA_PATH_MAP and the library mount` +
    `${example ? ` (not found here: ${example})` : ""}; what isn't readable is read through Plex`;
}
