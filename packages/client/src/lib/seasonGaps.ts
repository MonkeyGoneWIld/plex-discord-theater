import type { PlexItem, SeasonEpisode } from "./api";

/**
 * Working out what a season is missing.
 *
 * Kept out of the component because it is a rule rather than a rendering
 * decision, and because the rule has two edges that are easy to get wrong in
 * opposite directions: calling an unaired episode "missing" invites a request
 * that can't be filled, and calling a missing one "unaired" hides the only thing
 * worth acting on.
 */

/**
 * An episode TMDB lists that Plex doesn't have, and which of the two reasons
 * it is.
 *
 * The distinction is the whole point of showing these: "not aired" is nobody's
 * fault and nothing to do about, while "missing" means the season is incomplete
 * and worth requesting. Conflating them would make every currently airing show
 * look broken.
 */
export interface GapEpisode extends SeasonEpisode {
  kind: "missing" | "unaired";
}

/**
 * Grace given to an air date before its episode counts as missing.
 *
 * TMDB dates are day-resolution and carry no time zone, and `Date.parse` reads
 * them as midnight UTC — which is *earlier* than the episode actually airs
 * anywhere west of Greenwich. A US network show at 21:00 Pacific goes out at
 * 04:00 UTC the following day, so a 24-hour grace would label it missing four
 * hours before it had aired at all, which is precisely the confusion this
 * feature exists to remove.
 *
 * Two days covers every real time zone (down to UTC-12), a late-night slot, and
 * a few hours for the download to land. The error it leaves is the harmless
 * direction: an episode that genuinely never arrived reads as "not aired" for a
 * day longer than it should, and then corrects itself.
 */
export const AIR_DATE_GRACE_MS = 48 * 60 * 60 * 1000;

/**
 * An episode with no air date is unaired, not missing: TMDB lists episodes of
 * announced seasons long before scheduling them, and calling those missing is
 * wrong in the one direction that prompts a pointless request.
 */
export function classifyGap(ep: SeasonEpisode, now: number): GapEpisode["kind"] {
  if (!ep.airDate) return "unaired";
  const t = new Date(ep.airDate).getTime();
  if (Number.isNaN(t)) return "unaired";
  return t + AIR_DATE_GRACE_MS <= now ? "missing" : "unaired";
}

/**
 * Episodes TMDB knows about that Plex doesn't have, in episode order.
 *
 * Returns nothing when Plex has none of the season at all. That is a *wholly*
 * missing season, which the show page already represents as a single request
 * card — listing twenty absent episodes inside it would be a worse answer to the
 * same question. Also nothing when TMDB has no list, which is the ordinary state
 * without a TMDB key.
 */
export function findSeasonGaps(
  plexEpisodes: Pick<PlexItem, "index">[],
  sourceEpisodes: SeasonEpisode[] | null,
  now: number = Date.now(),
): GapEpisode[] {
  if (!sourceEpisodes || sourceEpisodes.length === 0) return [];
  if (plexEpisodes.length === 0) return [];
  const have = new Set(
    plexEpisodes.map((e) => e.index).filter((i): i is number => i != null),
  );
  return sourceEpisodes
    .filter((e) => !have.has(e.episodeNumber))
    .map((e) => ({ ...e, kind: classifyGap(e, now) }))
    .sort((a, b) => a.episodeNumber - b.episodeNumber);
}

/**
 * "12 March 2026", or null when TMDB has no usable date for the episode.
 *
 * Built from the parts rather than handed to `new Date(iso)`, because
 * "2026-01-25" is a calendar date and not an instant: `Date` reads it as
 * midnight UTC, and `toLocaleDateString` then renders it in local time, which
 * shows the *previous* day for everyone west of Greenwich. Every air date in
 * the Americas was a day early.
 */
export function formatAirDate(iso: string | null): string | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  return d.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
}

/**
 * What the toggle is hiding, named but never counted: "missing episodes",
 * "unaired episodes", or "missing and unaired episodes". Empty when there is
 * nothing to reveal.
 *
 * Deliberately no numbers. It used to read "Show 3 missing, 2 unaired", which
 * told anyone who hadn't finished the season exactly how much of it was left —
 * on the season page, above the episode list, before they had chosen to look.
 * How many episodes remain is the thing the collapsed list exists to keep back,
 * and a label that leaks it makes collapsing the list pointless.
 */
export function describeGaps(gaps: GapEpisode[]): string {
  const missing = gaps.some((g) => g.kind === "missing");
  const unaired = gaps.some((g) => g.kind === "unaired");
  if (missing && unaired) return "missing and unaired episodes";
  if (missing) return "missing episodes";
  if (unaired) return "unaired episodes";
  return "";
}
