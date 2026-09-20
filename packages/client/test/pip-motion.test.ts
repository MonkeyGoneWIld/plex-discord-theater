import assert from "node:assert/strict";
import {
  clampPipRect,
  pipDockForRect,
  projectPipRelease,
  releasePipDock,
  samplePipMotion,
  startPipMotion,
  type PipEdge,
  type PipMotion,
  type PipRect,
} from "../src/lib/pipMotion";

// These are pointer paths and visible placements, not snapshots of the motion
// implementation: a tap stays put, deliberate placement survives release, and
// a fling has a short, predictable carry along the chosen screen border.
const viewport = { width: 1440, height: 900 };
const windowSize = { width: 400, height: 225 };
const edgeRects: Record<PipEdge, PipRect> = {
  top: { ...windowSize, left: 520, top: 18 },
  right: { ...windowSize, left: 1022, top: 337.5 },
  bottom: { ...windowSize, left: 520, top: 657 },
  left: { ...windowSize, left: 18, top: 337.5 },
};

function motion(points: Array<[number, number, number]>): PipMotion {
  const [x, y, at] = points[0];
  const path = startPipMotion(x, y, at);
  for (const [nextX, nextY, nextAt] of points.slice(1)) {
    samplePipMotion(path, nextX, nextY, nextAt);
  }
  return path;
}

let passed = 0;
function check(name: string, run: () => void) {
  run();
  passed++;
  console.log(`  ok   ${name}`);
}

check("a stationary release at any border stays at that border's midpoint", () => {
  for (const edge of Object.keys(edgeRects) as PipEdge[]) {
    assert.deepEqual(releasePipDock(edgeRects[edge], viewport, edge, startPipMotion(0, 0, 0), 80), {
      edge, offset: 0.5,
    }, edge);
  }
});

check("one to four pixels of pointer jitter cannot launch PiP toward a corner", () => {
  for (const edge of Object.keys(edgeRects) as PipEdge[]) {
    for (const jitter of [1, 2, 3, 4]) {
      const path = motion([[0, 0, 0], [jitter, -jitter, 8]]);
      assert.deepEqual(projectPipRelease(edgeRects[edge], viewport, path, 12), edgeRects[edge]);
      assert.deepEqual(releasePipDock(edgeRects[edge], viewport, edge, path, 12), { edge, offset: 0.5 });
    }
  }
});

check("slow placement preserves the exact chosen position along every border", () => {
  const path = motion([[0, 0, 0], [40, 20, 200], [80, 40, 400], [120, 60, 600]]);
  const placements: Array<[PipEdge, PipRect, number]> = [
    ["top", { ...windowSize, left: 269, top: 22 }, 0.25],
    ["bottom", { ...windowSize, left: 771, top: 650 }, 0.75],
    ["left", { ...windowSize, left: 22, top: 177.75 }, 0.25],
    ["right", { ...windowSize, left: 1018, top: 497.25 }, 0.75],
  ];
  for (const [edge, rect, offset] of placements) {
    assert.deepEqual(releasePipDock(rect, viewport, "right", path, 620), { edge, offset });
  }
});

check("each deliberate fling continues along its border, with no perpendicular drift", () => {
  for (const edge of Object.keys(edgeRects) as PipEdge[]) {
    const horizontal = edge === "top" || edge === "bottom";
    for (const sign of [-1, 1]) {
      const path = horizontal
        ? motion([[0, 0, 0], [60 * sign, 2, 40], [120 * sign, 4, 80]])
        : motion([[0, 0, 0], [2, 60 * sign, 40], [4, 120 * sign, 80]]);
      const dock = releasePipDock(edgeRects[edge], viewport, edge, path, 85);
      assert.equal(dock.edge, edge);
      assert.ok(sign > 0 ? dock.offset > 0.5 : dock.offset < 0.5, `${edge}: carries in the release direction`);
      assert.ok(dock.offset > 0 && dock.offset < 1, `${edge}: a modest fling does not jump to a corner`);
    }
  }
});

check("a horizontal release near a side cannot unexpectedly switch to the top", () => {
  const path = motion([[0, 0, 0], [75, -1, 50], [150, -2, 100]]);
  const rect = { ...windowSize, left: 30, top: 70 };
  const dock = releasePipDock(rect, viewport, "left", path, 105);
  assert.equal(dock.edge, "left");
  assert.equal(dock.offset, pipDockForRect(rect, viewport, "left").offset);
});

check("corner noise keeps the current border but an intentional move can change it", () => {
  assert.equal(pipDockForRect({ ...windowSize, left: 1017, top: 18 }, viewport, "right").edge, "right");
  assert.equal(pipDockForRect({ ...windowSize, left: 992, top: 18 }, viewport, "right").edge, "top");
  assert.equal(pipDockForRect(edgeRects.left, viewport, "right").edge, "left");
});

check("a fast drag ending slowly is a placement, even with a fast overall average", () => {
  const path = motion([[0, 0, 0], [80, 0, 50], [160, 0, 100], [164, 0, 150], [166, 0, 200]]);
  assert.deepEqual(projectPipRelease(edgeRects.bottom, viewport, path, 205), edgeRects.bottom);
});

check("a fast final flick after a slow lead-in still has momentum", () => {
  const path = motion([[0, 0, 0], [20, 0, 800], [30, 0, 900], [80, 0, 950], [120, 0, 990]]);
  assert.ok(projectPipRelease(edgeRects.bottom, viewport, path, 995).left > edgeRects.bottom.left);
});

check("momentum follows the latest direction after reversing the drag", () => {
  const path = motion([[0, 0, 0], [200, 0, 100], [100, 0, 160], [60, 0, 200]]);
  assert.ok(projectPipRelease(edgeRects.bottom, viewport, path, 205).left < edgeRects.bottom.left);
});

check("holding before letting go cancels the throw, including when no new move event arrives", () => {
  const flick = motion([[0, 0, 0], [60, 0, 40], [120, 0, 80]]);
  assert.deepEqual(projectPipRelease(edgeRects.bottom, viewport, flick, 180), edgeRects.bottom);
  const held = motion([[0, 0, 0], [120, 0, 80], [120, 0, 140], [120, 0, 200]]);
  assert.deepEqual(projectPipRelease(edgeRects.bottom, viewport, held, 205), edgeRects.bottom);
});

check("same-frame or tiny-timestamp events cannot create an enormous throw", () => {
  for (const elapsed of [0, 1, 3, 10]) {
    const path = motion([[0, 0, 0], [120, 0, elapsed]]);
    assert.deepEqual(projectPipRelease(edgeRects.bottom, viewport, path, elapsed + 1), edgeRects.bottom);
  }
});

check("throw carry remains short even at extreme speeds", () => {
  const rect = edgeRects.bottom;
  const fast = motion([[0, 0, 0], [250, 0, 30], [500, 0, 60]]);
  const projected = projectPipRelease(rect, viewport, fast, 65);
  assert.ok(projected.left > rect.left);
  assert.ok(projected.left - rect.left <= 140);
  const modest = motion([[0, 0, 0], [25, 0, 25], [50, 0, 50]]);
  const modestCarry = projectPipRelease(rect, viewport, modest, 55).left - rect.left;
  assert.ok(modestCarry > 0 && modestCarry <= 30, "a short gesture gets proportionally short carry");
});

check("motion and docking stay within the viewport in desktop and mobile layouts", () => {
  const screens = [viewport, { width: 390, height: 844 }, { width: 844, height: 390 }];
  for (const screen of screens) {
    const rect = { left: screen.width - 245, top: screen.height - 145, width: 240, height: 135 };
    const path = motion([[0, 0, 0], [100, 100, 50], [200, 200, 100]]);
    const projected = projectPipRelease(rect, screen, path, 105);
    assert.ok(projected.left >= 0 && projected.left + rect.width <= screen.width);
    assert.ok(projected.top >= 0 && projected.top + rect.height <= screen.height);
    const dock = releasePipDock(rect, screen, "bottom", path, 105);
    assert.equal(dock.edge, "bottom");
    assert.ok(dock.offset >= 0 && dock.offset <= 1);
    assert.deepEqual(clampPipRect({ ...rect, left: -30, top: -20 }, screen), { ...rect, left: 0, top: 0 });
  }
});

check("a viewport with no space along an edge yields a finite stable placement", () => {
  const rect = { left: 0, top: 0, width: 240, height: 135 };
  const screen = { width: 240, height: 135 };
  const path = motion([[0, 0, 0], [60, 0, 40], [120, 0, 80]]);
  assert.deepEqual(releasePipDock(rect, screen, "bottom", path, 85), { edge: "bottom", offset: 0 });
});

check("equivalent sparse and frequent pointer updates produce comparable carry", () => {
  const sparse = motion([[0, 0, 0], [100, 0, 100]]);
  const dense = motion(Array.from({ length: 11 }, (_, index) => [index * 10, 0, index * 10] as [number, number, number]));
  const sparseCarry = projectPipRelease(edgeRects.bottom, viewport, sparse, 105).left - edgeRects.bottom.left;
  const denseCarry = projectPipRelease(edgeRects.bottom, viewport, dense, 105).left - edgeRects.bottom.left;
  assert.ok(sparseCarry > 0, "coalesced or lower-frequency pointer events still support a deliberate fling");
  assert.ok(Math.abs(sparseCarry - denseCarry) < 3, "event frequency does not change the perceived momentum");
});

console.log(`\n${passed} PiP motion regression scenarios passed.`);
