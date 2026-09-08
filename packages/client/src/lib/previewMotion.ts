import type { PreviewDetail } from "./previewFrames";

export const PREVIEW_SETTLE_MS = 650;
const PRECISE_DWELL_MS = 500;

/** Keep the overview's width-based speed, but reserve full detail for deliberate
 * inspection: both little screen travel and few original frames per second.
 * A width-only threshold turns into hundreds of frames/second on a long film. */
export function createPreviewMotion() {
  let previous: { pct: number; time: number } | null = null;
  let speed = 0;
  let detail: PreviewDetail = "medium";
  let slowSince: number | null = null;
  return {
    reset() { previous = null; speed = 0; detail = "medium"; slowSince = null; },
    settle(): PreviewDetail { detail = "full"; return detail; },
    sample(pct: number, time: number, frameCount = 0): PreviewDetail {
      if (previous && time > previous.time) {
        const elapsed = time - previous.time;
        const instant = Math.abs(pct - previous.pct) * 1000 / elapsed;
        // Accelerate immediately; decay smoothly with real elapsed time.
        speed = elapsed > 300 ? instant : Math.max(instant, speed * Math.exp(-elapsed / 80));
        // The time spent stopped is not evidence of slow movement on resuming.
        if (elapsed >= PREVIEW_SETTLE_MS) { detail = "medium"; slowSince = null; }
        const count = Number.isFinite(frameCount) ? Math.max(1, frameCount) : 1;
        const enterFull = Math.min(0.008, 6 / count);
        const leaveFull = Math.min(0.015, 10 / count);
        if (speed >= 0.8 || (detail === "coarse" && speed >= 0.55)) {
          detail = "coarse";
          slowSince = null;
        } else if (detail === "full" && speed <= leaveFull) {
          // Once inspecting an area, tiny speed variations should not interrupt it.
        } else if (speed <= enterFull) {
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
