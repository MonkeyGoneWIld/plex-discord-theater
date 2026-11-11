import { plexFetch, plexJSON } from "../services/plex.js";

/**
 * What the dashboard shows of a title beside its name: its poster, how long
 * it runs, and where an episode sits in its series. Asked of Plex by
 * ratingKey and kept in memory, since a page of history asks for the same
 * few titles again and again.
 */

export interface TitleInfo {
  ratingKey: string;
  type: string | null;
  title: string | null;
  /** An episode's series, season and number. */
  show: string | null;
  season: number | null;
  episode: number | null;
  year: number | null;
  durationS: number | null;
  /** Whether Plex has a poster for it (the series' for an episode). */
  poster: boolean;
}

/** Where the dashboard gets them; the tests give their own. */
export interface TitleSource {
  info(ratingKey: string): Promise<TitleInfo | null>;
  poster(ratingKey: string): Promise<{ type: string; body: Buffer } | null>;
}

const INFO_TTL_MS = 6 * 3_600_000;
const MISSING_TTL_MS = 5 * 60_000;
const MAX_INFO = 2_000;
const MAX_POSTERS = 300;
const POSTER_WIDTH = 480;
const POSTER_HEIGHT = 720;

interface Kept { at: number; info: TitleInfo | null; thumb: string | null }

export const okRatingKey = (v: unknown): v is string => typeof v === "string" && /^\d{1,12}$/.test(v);

export function plexTitles(): TitleSource {
  const infos = new Map<string, Kept>();
  const asking = new Map<string, Promise<Kept>>();
  const posters = new Map<string, { type: string; body: Buffer } | null>();

  const ask = async (ratingKey: string): Promise<Kept> => {
    try {
      const data = await plexJSON<{ MediaContainer?: { Metadata?: Array<Record<string, unknown>> } }>(`/library/metadata/${ratingKey}`);
      const m = data.MediaContainer?.Metadata?.[0];
      if (!m) return { at: Date.now(), info: null, thumb: null };
      const text = (v: unknown) => (typeof v === "string" && v ? v : null);
      const whole = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
      // A series' poster for its episodes: an episode's own picture is a
      // frame of it, wide, and says less at a glance.
      const thumb = text(m.grandparentThumb) ?? text(m.parentThumb) ?? text(m.thumb);
      const duration = whole(m.duration);
      return {
        at: Date.now(),
        thumb,
        info: {
          ratingKey,
          type: text(m.type),
          title: text(m.title),
          show: text(m.grandparentTitle),
          season: whole(m.parentIndex),
          episode: whole(m.index),
          year: whole(m.year),
          durationS: duration === null ? null : Math.round(duration / 1000),
          poster: !!thumb,
        },
      };
    } catch {
      return { at: Date.now(), info: null, thumb: null };
    }
  };

  const kept = (ratingKey: string): Promise<Kept> => {
    const had = infos.get(ratingKey);
    if (had && Date.now() - had.at < (had.info ? INFO_TTL_MS : MISSING_TTL_MS)) return Promise.resolve(had);
    const going = asking.get(ratingKey);
    if (going) return going;
    const p = ask(ratingKey).then((k) => {
      asking.delete(ratingKey);
      infos.delete(ratingKey);
      infos.set(ratingKey, k);
      if (infos.size > MAX_INFO) infos.delete(infos.keys().next().value!);
      return k;
    });
    asking.set(ratingKey, p);
    return p;
  };

  return {
    info: async (ratingKey) => (await kept(ratingKey)).info,
    poster: async (ratingKey) => {
      if (posters.has(ratingKey)) return posters.get(ratingKey) ?? null;
      const { thumb } = await kept(ratingKey);
      let found: { type: string; body: Buffer } | null = null;
      if (thumb) {
        try {
          const res = await plexFetch("/photo/:/transcode", {
            url: thumb, width: String(POSTER_WIDTH), height: String(POSTER_HEIGHT), minSize: "1", upscale: "0",
          });
          const type = res.headers.get("content-type") ?? "";
          if (res.ok && type.startsWith("image/")) found = { type, body: Buffer.from(await res.arrayBuffer()) };
        } catch {
          found = null;
        }
      }
      // One not found is asked for again when its title is.
      if (found || !thumb) {
        posters.set(ratingKey, found);
        if (posters.size > MAX_POSTERS) posters.delete(posters.keys().next().value!);
      }
      return found;
    },
  };
}
