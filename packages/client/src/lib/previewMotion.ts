import type { PreviewDetail } from "./previewFrames";

/** Speed is measured in timeline widths per second, independent of runtime.
 * Hysteresis keeps small speed variations from flipping between levels. */
export function createPreviewMotion() {
  let previous: { pct: number; time: number } | null = null;
  let speed = 0;
  let detail: PreviewDetail = "full";
  return {
    reset() { previous = null; speed = 0; detail = "full"; },
    sample(pct: number, time: number): PreviewDetail {
      if (previous && time > previous.time) {
        const elapsed = time - previous.time;
        const instant = Math.abs(pct - previous.pct) * 1000 / elapsed;
        // Accelerate immediately; decay smoothly with real elapsed time.
        speed = elapsed > 300 ? instant : Math.max(instant, speed * Math.exp(-elapsed / 80));
        if (speed >= 0.8) detail = "coarse";
        else if (detail === "coarse" && speed >= 0.55) detail = "coarse";
        else if (speed >= 0.12) detail = "medium";
        else if (detail !== "full" && speed >= 0.07) detail = "medium";
        else detail = "full";
      }
      previous = { pct, time };
      return detail;
    },
  };
}
