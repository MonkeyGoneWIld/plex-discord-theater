export type PipEdge = "top" | "right" | "bottom" | "left";
export interface PipRect { left: number; top: number; width: number; height: number }
export interface PipDock { edge: PipEdge; offset: number }
export interface PipViewport { width: number; height: number }
export interface PipSample { x: number; y: number; at: number }
export interface PipMotion { start: PipSample; samples: PipSample[] }

export const PIP_MARGIN = 18;
export const PIP_DRAG_SLOP = 6;
const VELOCITY_WINDOW_MS = 100;

export function startPipMotion(x: number, y: number, at: number): PipMotion {
  const start = { x, y, at };
  return { start, samples: [start] };
}

export function samplePipMotion(motion: PipMotion, x: number, y: number, at: number): void {
  motion.samples.push({ x, y, at });
  // Keep one sample outside the window so event frequency doesn't determine
  // whether a fast release has enough history to estimate its velocity.
  while (motion.samples.length > 2 && motion.samples[1].at < at - VELOCITY_WINDOW_MS) {
    motion.samples.shift();
  }
}

export function clampPipRect(rect: PipRect, viewport: PipViewport): PipRect {
  return {
    ...rect,
    left: Math.max(0, Math.min(viewport.width - rect.width, rect.left)),
    top: Math.max(0, Math.min(viewport.height - rect.height, rect.top)),
  };
}

/** A short, decelerating carry. Only the recent release motion contributes. */
export function projectPipRelease(rect: PipRect, viewport: PipViewport, motion: PipMotion, now: number): PipRect {
  const last = motion.samples.at(-1)!;
  const cutoff = now - VELOCITY_WINDOW_MS;
  const index = motion.samples.findIndex((sample) => sample.at >= cutoff);
  let first = motion.samples[index];
  if (index > 0) {
    const previous = motion.samples[index - 1];
    const fraction = (cutoff - previous.at) / (first.at - previous.at);
    first = {
      x: previous.x + (first.x - previous.x) * fraction,
      y: previous.y + (first.y - previous.y) * fraction,
      at: cutoff,
    };
  }
  const totalDistance = Math.hypot(last.x - motion.start.x, last.y - motion.start.y);
  if (!first || now - last.at > 70 || totalDistance < 40) return rect;
  const elapsed = now - first.at;
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  // Reject jitter, isolated same-frame events and a slow/held release. A long
  // fast drag ending slowly is a placement, even if its average speed is high.
  if (elapsed < 24 || Math.hypot(dx, dy) < 24) return rect;
  let vx = dx / elapsed;
  let vy = dy / elapsed;
  if (Math.hypot(vx, vy) < 0.55) return rect;
  if (Math.abs(vx) > Math.abs(vy) * 2) vy = 0;
  else if (Math.abs(vy) > Math.abs(vx) * 2) vx = 0;
  const speed = Math.hypot(vx, vy);
  const distance = Math.min(140, totalDistance * 0.6, (speed - 0.35) * 140);
  return clampPipRect({
    ...rect,
    left: rect.left + vx / speed * distance,
    top: rect.top + vy / speed * distance,
  }, viewport);
}

/** Snap only the perpendicular coordinate; preserve placement along an edge. */
export function pipDockForRect(rect: PipRect, viewport: PipViewport, previousEdge: PipEdge): PipDock {
  const distances: Record<PipEdge, number> = {
    top: Math.abs(rect.top - PIP_MARGIN),
    right: Math.abs(viewport.width - rect.left - rect.width - PIP_MARGIN),
    bottom: Math.abs(viewport.height - rect.top - rect.height - PIP_MARGIN),
    left: Math.abs(rect.left - PIP_MARGIN),
  };
  let edge = previousEdge;
  for (const candidate of ["top", "right", "bottom", "left"] as const) {
    if (distances[candidate] < distances[edge]) edge = candidate;
  }
  // A small tie region prevents border switching from pointer noise near a
  // corner. It never forces a distant edge based on the direction of travel.
  if (distances[previousEdge] <= distances[edge] + 12) edge = previousEdge;
  return dockAlongEdge(rect, viewport, edge);
}

function dockAlongEdge(rect: PipRect, viewport: PipViewport, edge: PipEdge): PipDock {
  const horizontal = edge === "top" || edge === "bottom";
  const travel = horizontal
    ? viewport.width - rect.width - PIP_MARGIN * 2
    : viewport.height - rect.height - PIP_MARGIN * 2;
  const position = (horizontal ? rect.left : rect.top) - PIP_MARGIN;
  return { edge, offset: travel > 0 ? Math.max(0, Math.min(1, position / travel)) : 0 };
}

export function releasePipDock(rect: PipRect, viewport: PipViewport, previousEdge: PipEdge, motion: PipMotion, now: number): PipDock {
  const dock = pipDockForRect(rect, viewport, previousEdge);
  // The drop position chooses the border. Momentum can coast along it but
  // cannot change that choice or teleport across the viewport to another edge.
  return dockAlongEdge(projectPipRelease(rect, viewport, motion, now), viewport, dock.edge);
}
