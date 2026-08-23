/**
 * The one surface a quiet button gets.
 *
 * "Quiet" meaning: a control that is not the primary action on its screen and
 * is not carrying a colour of its own. Back, Start Over, Mark watched, Clear,
 * Load more, Exit, Ignore, the track dropdowns — everything whose job is to be
 * pressable without competing with the amber.
 *
 * It exists because there were twelve of these. Not twelve deliberate weights
 * for twelve different jobs: twelve answers to one question, written at
 * different times, with backgrounds from 0% to 8% and borders from 6% to 18%.
 * Start Over sat next to Mark watched in the same row, meaning the same thing,
 * at transparent/18% against 6%/14% — which is how it was noticed. The Back
 * button had three surfaces depending on which page you had reached it from.
 *
 * A fill rather than an outline, because these sit over posters, backdrops and
 * video. An unfilled box is only its border, and a border is the first thing to
 * disappear against a bright frame.
 *
 * Spread it; don't copy the values. That is the whole point of it being here.
 */
export const QUIET_SURFACE = {
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.14)",
} as const;

/**
 * The surface for a secondary standing next to the primary.
 *
 * Start Over, Watchlist and Mark watched are the three controls that share a
 * row with Play. Filling them puts three lit panels around the one button that
 * is supposed to be the loudest thing there; leaving them as outlines lets the
 * amber carry the row on its own and reads the difference between "the action"
 * and "the other things you could do" without needing a colour to say it.
 *
 * The distinction is proximity, not importance. A quiet control standing on its
 * own — Back, Clear, Load more, a track dropdown — has nothing to defer to and
 * takes QUIET_SURFACE, where a fill is what keeps it legible over artwork.
 */
export const GHOST_SURFACE = {
  background: "transparent",
  border: "1px solid rgba(255,255,255,0.18)",
} as const;
