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
  return (
    <div style={styles.wrap} role="status" aria-label="Loading">
      <div style={styles.spinner} />
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
    // Defined in index.html alongside the skeleton shimmer.
    animation: "spin 0.8s linear infinite",
  },
};
