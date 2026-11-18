import { lazy, Suspense } from "react";
import type { PersonPlay } from "./types";

// The charts, and Recharts with them, load only when a page shows one: the
// Activity page doesn't wait for them.
const charts = () => import("./Graphs");
const LazyGraphs = lazy(() => charts().then((m) => ({ default: m.Graphs })));
const LazyMini = lazy(() => charts().then((m) => ({ default: m.MiniChart })));
const LazyLoad = lazy(() => charts().then((m) => ({ default: m.SystemLoadPanel })));
const LazyTrends = lazy(() => charts().then((m) => ({ default: m.PersonTrends })));

export function GraphsTab(props: { onError: (e: unknown) => void }) {
  return <Suspense fallback={<p className="empty">Loading…</p>}><LazyGraphs {...props} /></Suspense>;
}

export function MiniChart(props: { kind: "plays" | "people" | "data" | "servers" | "requests"; onError: (e: unknown) => void }) {
  return <Suspense fallback={null}><LazyMini {...props} /></Suspense>;
}

/** The System page's server load charts. */
export function SystemLoadPanel(props: { onError: (e: unknown) => void }) {
  return <Suspense fallback={<p className="empty">Loading…</p>}><LazyLoad {...props} /></Suspense>;
}

/** A user's weekly watch time, sessions and buffering. */
export function PersonTrends(props: { plays: PersonPlay[] }) {
  return <Suspense fallback={null}><LazyTrends {...props} /></Suspense>;
}
