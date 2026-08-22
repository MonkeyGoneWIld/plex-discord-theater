import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { ErrorBoundary } from "./components/ErrorBoundary";

/**
 * Let :active fire under a finger.
 *
 * WebKit only applies :active to a touch when the document has a touch
 * listener attached; without one it decides nothing is interactive and the
 * press styles never come on. That went unnoticed while the webview was
 * painting its own highlight over every tap — taking that away (see index.html)
 * would have left a phone with no press feedback at all rather than with the
 * same feedback as a desktop.
 *
 * Passive, so it never delays a scroll, and empty because attaching it is the
 * entire effect.
 */
document.addEventListener("touchstart", () => {}, { passive: true });

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary
      fallback={
        <div style={{
          display: "flex", flexDirection: "column", alignItems: "center",
          justifyContent: "center", minHeight: "100vh", gap: "16px",
          background: "#0d0d0d", color: "#f0f0f0", fontFamily: "DM Sans, sans-serif",
        }}>
          <p style={{ fontSize: "16px", color: "#e74c3c" }}>Something went wrong</p>
          <button className="btn"
            onClick={() => window.location.reload()}
            style={{
              padding: "10px 24px", borderRadius: "8px", border: "none",
              background: "#e5a00d", color: "#000", fontSize: "14px",
              fontWeight: 600, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            Reload
          </button>
        </div>
      }
    >
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
