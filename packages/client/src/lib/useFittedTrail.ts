import { useEffect, useLayoutEffect, useRef, useState } from "react";

/**
 * A breadcrumb trail, shorter one crumb at a time: the page's own crumb goes
 * first — its title is the page's heading anyway — then the ancestors furthest
 * from it, down to the first (Home) alone.
 *
 *   Home › Show › Season 1 › Episode 4
 *   Home › Show › Season 1
 *   Home › Season 1
 *   Home
 */
export function trailSteps<T>(trail: T[]): T[][] {
  const steps = [trail];
  if (trail.length > 1) {
    const ancestors = trail.slice(1, -1);
    for (let keep = ancestors.length; keep >= 0; keep--) {
      steps.push([trail[0], ...ancestors.slice(ancestors.length - keep)]);
    }
  }
  return steps;
}

/**
 * As much of a trail as fits its row, never a label cut short.
 *
 * Give the returned ref to the element holding the crumbs, which has to take
 * whatever room its row leaves it (flex: 1, min-width: 0, overflow: hidden)
 * and hold crumbs that don't shrink. Before each paint it tries the whole
 * trail and then one step shorter for as long as that runs past the room; when
 * the room changes, or the trail does, it starts again from the whole of it.
 *
 * `key` names the trail — its labels — so a new page is fitted afresh.
 */
export function useFittedTrail<T>(trail: T[], key: string): { shown: T[]; ref: (el: HTMLElement | null) => void } {
  const steps = trailSteps(trail);
  const [dropped, setDropped] = useState(0);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const [room, setRoom] = useState(0);

  useEffect(() => {
    if (!el || typeof ResizeObserver === "undefined") return;
    // The element's width follows the room it is given, not what it holds, so
    // this fires for a resize or a neighbour growing — not for a fit step.
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      setRoom((n) => n + 1);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [el]);

  const fitKey = `${key}|${room}`;
  const fittedFor = useRef(fitKey);
  useLayoutEffect(() => {
    if (fittedFor.current !== fitKey) {
      fittedFor.current = fitKey;
      if (dropped !== 0) {
        setDropped(0);
        return;
      }
    }
    if (!el) return;
    if (el.scrollWidth > el.clientWidth + 1 && dropped < steps.length - 1) setDropped(dropped + 1);
  });

  return { shown: steps[Math.min(dropped, steps.length - 1)], ref: setEl };
}
