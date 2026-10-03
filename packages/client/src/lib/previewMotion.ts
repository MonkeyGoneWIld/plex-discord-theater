import type { PreviewDetail } from "./previewFrames";

/** Resting within FOCUS_RADIUS_PX for this long switches to full detail. */
export const PREVIEW_SETTLE_MS = 250;
/** Moving slower than PRECISE_SPEED_PX for this long also switches to full detail. */
const PRECISE_DWELL_MS = 150;
const FOCUS_RADIUS_PX = 24;
/** Pixels per second that count as holding still. */
const PRECISE_SPEED_PX = 50;
/** Full detail holds until movement passes twice the way in, so it doesn't flicker at the edge. */
const PRECISE_EXIT_SPEED_PX = PRECISE_SPEED_PX * 2;
/** Sweeping faster than this, in fractions of the bar per second, shows the coarse tier... */
const COARSE_ENTER_SPEED = 1.2;
/** ...and it stays coarse until the sweep slows below this. */
const COARSE_EXIT_SPEED = 0.8;

/** Broad sweeps use timeline speed. Precise inspection uses screen pixels and
 * a local focus window, so video length and one-pixel jitter cannot lock it out. */
export function createPreviewMotion() {
  let previous: { pct: number; time: number } | null = null;
  let speed = 0;
  let preciseSpeed = 0;
  let detail: PreviewDetail = "medium";
  let slowSince: number | null = null;
  let focus: { pct: number; time: number } | null = null;
  return {
    reset() { previous = null; focus = null; speed = 0; preciseSpeed = 0; detail = "medium"; slowSince = null; },
    settleDelay(time: number) { return Math.max(0, PREVIEW_SETTLE_MS - (time - (focus?.time ?? time))); },
    settle(time: number): PreviewDetail {
      if (focus && time - focus.time >= PREVIEW_SETTLE_MS) detail = "full";
      return detail;
    },
    sample(pct: number, time: number, width = 1000): PreviewDetail {
      width = Number.isFinite(width) && width > 0 ? width : 1000;
      if (!focus || Math.abs(pct - focus.pct) * width > FOCUS_RADIUS_PX) focus = { pct, time };
      if (previous && time > previous.time) {
        const elapsed = time - previous.time;
        const instant = Math.abs(pct - previous.pct) * 1000 / elapsed;
        speed = elapsed > 300 ? instant : Math.max(instant, speed * Math.exp(-elapsed / 80));
        // Average over real time: a single pixel in a short pointer event is
        // not evidence of fast searching. The coarse tier still reacts instantly.
        const weight = 1 - Math.exp(-elapsed / 150);
        preciseSpeed = elapsed > PREVIEW_SETTLE_MS ? instant * width
          : preciseSpeed + weight * (instant * width - preciseSpeed);
        if (speed >= COARSE_ENTER_SPEED || (detail === "coarse" && speed >= COARSE_EXIT_SPEED)) {
          detail = "coarse";
          slowSince = null;
          focus = { pct, time };
        } else if (time - focus.time >= PREVIEW_SETTLE_MS || (detail === "full" && preciseSpeed <= PRECISE_EXIT_SPEED_PX)) {
          detail = "full";
        } else if (preciseSpeed <= PRECISE_SPEED_PX) {
          slowSince ??= time;
          detail = time - slowSince >= PRECISE_DWELL_MS ? "full" : "medium";
        } else {
          detail = "medium";
          slowSince = null;
        }
      }
      previous = { pct, time };
      return detail;
    },
  };
}
