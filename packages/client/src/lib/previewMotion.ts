import type { PreviewDetail } from "./previewFrames";

export const PREVIEW_SETTLE_MS = 650;
const PRECISE_DWELL_MS = 500;
const FOCUS_RADIUS_PX = 12;

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
        if (speed >= 0.8 || (detail === "coarse" && speed >= 0.55)) {
          detail = "coarse";
          slowSince = null;
          focus = { pct, time };
        } else if (time - focus.time >= PREVIEW_SETTLE_MS || (detail === "full" && preciseSpeed <= 40)) {
          detail = "full";
        } else if (preciseSpeed <= 20) {
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
