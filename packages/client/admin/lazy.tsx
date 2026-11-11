import { lazy, Suspense } from "react";

// The charts, and Recharts with them, load only when a page shows one: the
// Now playing page doesn't wait for them.
const charts = () => import("./Graphs");
const LazyGraphs = lazy(() => charts().then((m) => ({ default: m.Graphs })));
const LazyMini = lazy(() => charts().then((m) => ({ default: m.MiniChart })));

export function GraphsTab(props: { onError: (e: unknown) => void }) {
  return <Suspense fallback={<p className="empty">Loading…</p>}><LazyGraphs {...props} /></Suspense>;
}

export function MiniChart(props: { kind: "plays" | "people" | "data"; onError: (e: unknown) => void }) {
  return <Suspense fallback={null}><LazyMini {...props} /></Suspense>;
}
