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
