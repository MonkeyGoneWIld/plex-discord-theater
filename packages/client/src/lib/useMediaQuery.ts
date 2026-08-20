import { useEffect, useState } from "react";

/**
 * Subscribe to a CSS media query.
 *
 * Everything in this app is styled inline, which has no way to express a
 * breakpoint, so responsive decisions get made in JS instead. Reads
 * synchronously on first render rather than in an effect, so a layout never
 * paints at the wrong size and then jumps.
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const mql = window.matchMedia(query);
    // Re-read on subscribe: the query may have changed, or the viewport may have
    // moved between the first render and this effect.
    setMatches(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

/** Phone-width portrait, where a side-by-side poster and detail column can't both fit. */
export const NARROW_QUERY = "(max-width: 720px)";

/**
 * Wide enough for the search view's Back button to sit beside the box.
 *
 * Back is pinned to the top-left of the view, the same place it sits on every
 * other page — that consistency is the point of it, so it does not move to make
 * room. The room comes from the margin either side of the centred 1200px
 * column, and below a certain width there isn't any: the column reaches the
 * edges, the box's left edge arrives at 24px, and the button is on top of it.
 *
 * The arithmetic, so it can be re-derived if either number changes: the button
 * is ~90px wide at a 24px gutter, so it ends at 114px. The box's left edge is
 * at (viewport - 1200) / 2 + 24. They touch at 1380px. 1440 is the next round
 * number up and leaves a 30px gap at the boundary.
 *
 * Under it the button is not shown at all. The box's own X clears the query,
 * which is what actually ends a search — the button was never the only way out,
 * and half a button under the text is worse than none.
 */
export const ROOM_BESIDE_SEARCH_QUERY = "(min-width: 1440px)";

/**
 * Phone held sideways. Landscape alone would also match every desktop window,
 * so the height cap is what keeps this to devices that are actually short.
 */
export const MOBILE_LANDSCAPE_QUERY = "(orientation: landscape) and (max-height: 600px)";

/**
 * Screens with no room for a full-size player control bar: a phone in portrait
 * runs out of width, a phone in landscape runs out of height. Comma is OR.
 */
export const COMPACT_CONTROLS_QUERY = "(max-width: 820px), (max-height: 600px)";

/**
 * A phone, held either way.
 *
 * The union of the two above, for the decisions that don't care about
 * orientation — chiefly whether Discord's own mobile chrome is already offering
 * something, in which case this app shouldn't offer it a second time. Comma is OR.
 */
export const PHONE_QUERY = `${NARROW_QUERY}, ${MOBILE_LANDSCAPE_QUERY}`;

// Note: keeping clear of Discord's own chrome is NOT done with a media query.
// Discord publishes the space it occupies as --discord-safe-area-inset-*, which
// index.html folds into --sait/--saib/--sail/--sair; the bars add those to their
// padding. Real numbers, both orientations, no breakpoint to maintain.
