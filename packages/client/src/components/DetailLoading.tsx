import { useEffect, useState } from "react";

/**
 * Do not flash the loading screen for a warm cache hit.
 *
 * Even when the server and browser already have every detail, the HTTP response,
 * image-complete ref and React effects settle on separate microtasks/frames. The
 * detail gate is intentionally kept in place, but its spinner should only become
 * visible when the wait is long enough to be perceptible as a real load.
 */
const SPINNER_DELAY_MS = 180;

/**
 * The detail pages' loading state.
 *
 * A spinner rather than a skeleton. A skeleton has to predict the page it
 * stands in for, and these pages vary — a film with no collection, a show with
 * five seasons, an episode with a landscape still — so it kept promising a
 * shape the real page didn't have, which reads worse than an honest wait.
 *
 * Sized to roughly a screen so the page doesn't collapse to nothing underneath
 * it and bounce the scroll position when the content arrives.
 */
export function DetailLoading() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => setVisible(true), SPINNER_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      style={styles.wrap}
      role={visible ? "status" : undefined}
      aria-label={visible ? "Loading" : undefined}
    >
      <div style={{ ...styles.spinner, opacity: visible ? 1 : 0 }} />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "70vh",
    width: "100%",
  },
  spinner: {
    width: "44px",
    height: "44px",
    borderRadius: "50%",
    border: "3px solid rgba(255,255,255,0.10)",
    borderTopColor: "#e5a00d",
    opacity: 0,
    transition: "opacity 0.12s ease",
    // Defined in index.html alongside the skeleton shimmer.
    animation: "spin 0.8s linear infinite",
  },
};
