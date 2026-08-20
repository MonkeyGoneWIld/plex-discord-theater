import { useCallback, useEffect, useRef, useState } from "react";
import {
  fetchPlexAccountStatus,
  pollPlexAccountLink,
  startPlexAccountLink,
  syncPlexAccount,
  unlinkPlexAccount,
  type PlexAccountStatus,
} from "../lib/api";

interface PlexAccountButtonProps {
  compact?: boolean;
  onHistoryChanged?: () => void;
}

const AUTO_SYNC_AFTER_MS = 15 * 60 * 1000;

function when(value: number | null): string {
  if (!value) return "Not synced yet";
  return `Last synced ${new Date(value).toLocaleString()}`;
}

export function PlexAccountButton({ compact = false, onHistoryChanged }: PlexAccountButtonProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<PlexAccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const autoSyncStarted = useRef(false);

  const runSync = useCallback(async (quiet = false) => {
    setBusy(true);
    if (!quiet) setMessage(null);
    try {
      const result = await syncPlexAccount();
      setStatus(result.status);
      setMessage(`Synced ${result.imported} from Plex and ${result.exported} to Plex.`);
      onHistoryChanged?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Plex history sync failed");
      setStatus((old) => old ? { ...old, lastSyncError: err instanceof Error ? err.message : String(err) } : old);
    } finally {
      setBusy(false);
    }
  }, [onHistoryChanged]);

  useEffect(() => {
    let cancelled = false;
    fetchPlexAccountStatus()
      .then((next) => {
        if (cancelled) return;
        setStatus(next);
        if (
          next.linked &&
          !autoSyncStarted.current &&
          (!next.lastSyncAt || Date.now() - next.lastSyncAt > AUTO_SYNC_AFTER_MS)
        ) {
          autoSyncStarted.current = true;
          void runSync(true);
        }
      })
      .catch(() => {
        // Account linking is optional; a status failure must not affect the app.
      });
    return () => { cancelled = true; };
  }, [runSync]);

  useEffect(() => {
    if (!status?.pending || status.linked) return;
    let cancelled = false;
    const check = async () => {
      try {
        const next = await pollPlexAccountLink();
        if (cancelled) return;
        setStatus(next);
        if (next.linked) {
          setMessage(`Linked ${next.account?.username ?? "Plex account"}. Importing history...`);
          await runSync();
        }
      } catch (err) {
        if (!cancelled) setMessage(err instanceof Error ? err.message : "Could not finish Plex sign-in");
      }
    };
    const timer = window.setInterval(() => void check(), 2000);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status?.pending?.authUrl, status?.linked, runSync]);

  const beginLink = async () => {
    setBusy(true);
    setMessage(null);
    // Reserve the window during the click event; opening it after the network
    // response is commonly blocked as an unsolicited popup.
    const popup = window.open("about:blank", "plex-account-link");
    if (popup) popup.opener = null;
    try {
      const next = await startPlexAccountLink();
      setStatus(next);
      if (next.pending?.authUrl) {
        if (popup) popup.location.href = next.pending.authUrl;
        else window.open(next.pending.authUrl, "_blank", "noopener,noreferrer");
        setMessage("Finish signing in on Plex. This window will update automatically.");
      }
    } catch (err) {
      popup?.close();
      setMessage(err instanceof Error ? err.message : "Could not start Plex sign-in");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    if (!window.confirm("Disconnect your Plex account? Local Activity history will be kept.")) return;
    setBusy(true);
    setMessage(null);
    try {
      await unlinkPlexAccount();
      setStatus({ linked: false, lastSyncAt: null, lastSyncError: null });
      autoSyncStarted.current = false;
      setMessage("Plex account disconnected. Local history was kept.");
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not disconnect Plex");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ ...styles.trigger, ...(status?.linked ? styles.triggerLinked : {}) }}
        title={status?.linked ? `Plex linked as ${status.account?.username}` : "Link Plex account"}
      >
        <span style={styles.plexMark}>P</span>
        {!compact && <span>{status?.linked ? "Plex linked" : "Link Plex"}</span>}
      </button>

      {open && (
        <div style={styles.overlay} role="presentation" onMouseDown={(e) => {
          if (e.target === e.currentTarget) setOpen(false);
        }}>
          <section style={styles.modal} role="dialog" aria-modal="true" aria-labelledby="plex-account-title">
            <div style={styles.headingRow}>
              <div>
                <div style={styles.eyebrow}>OPTIONAL ACCOUNT SYNC</div>
                <h2 id="plex-account-title" style={styles.title}>Plex watch history</h2>
              </div>
              <button type="button" onClick={() => setOpen(false)} style={styles.close} aria-label="Close">&times;</button>
            </div>

            {status?.linked ? (
              <>
                <div style={styles.accountCard}>
                  <span style={{ ...styles.plexMark, ...styles.largeMark }}>P</span>
                  <div>
                    <div style={styles.accountName}>{status.account?.username}</div>
                    <div style={styles.secondary}>{status.account?.email || "Plex account connected"}</div>
                  </div>
                </div>
                <p style={styles.copy}>
                  Progress from this Activity is sent to your Plex account. Plex watch history and resume positions are also imported here. Every participant links and syncs independently.
                </p>
                <div style={styles.syncStatus}>
                  <span>{when(status.lastSyncAt)}</span>
                  {status.lastSyncError && <span style={styles.error}>{status.lastSyncError}</span>}
                </div>
                <div style={styles.actions}>
                  <button type="button" disabled={busy} onClick={() => void runSync()} style={styles.primary}>
                    {busy ? "Syncing..." : "Sync now"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => void disconnect()} style={styles.danger}>
                    Disconnect
                  </button>
                </div>
              </>
            ) : (
              <>
                <p style={styles.copy}>
                  Link your own Plex account to sync watched titles and resume positions in both directions. During a watch party, every linked participant who has the player open receives credit on their own account.
                </p>
                <p style={styles.privacy}>
                  You sign in directly on plex.tv. Your password never reaches this app, and the resulting account token is encrypted and stored only on the server.
                </p>
                {status?.pending ? (
                  <div style={styles.pending}>
                    <div>Waiting for Plex authorization...</div>
                    <a href={status.pending.authUrl} target="_blank" rel="noreferrer" style={styles.link}>Open Plex sign-in again</a>
                  </div>
                ) : (
                  <button type="button" disabled={busy} onClick={() => void beginLink()} style={styles.primary}>
                    {busy ? "Starting..." : "Continue with Plex"}
                  </button>
                )}
              </>
            )}

            {message && <div style={styles.message} role="status">{message}</div>}
          </section>
        </div>
      )}
    </>
  );
}

const styles: Record<string, React.CSSProperties> = {
  trigger: {
    display: "inline-flex", alignItems: "center", gap: "6px", padding: "5px 9px",
    borderRadius: "8px", border: "1px solid rgba(255,255,255,0.12)",
    background: "rgba(255,255,255,0.05)", color: "#b6b6b6", cursor: "pointer",
    fontFamily: "inherit", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap",
  },
  triggerLinked: { color: "#e5a00d", border: "1px solid rgba(229,160,13,0.3)" },
  plexMark: {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: "17px", height: "17px", borderRadius: "4px", background: "#e5a00d",
    color: "#161616", fontSize: "11px", fontWeight: 900,
  },
  overlay: {
    position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center",
    justifyContent: "center", padding: "20px", background: "rgba(0,0,0,0.72)",
    backdropFilter: "blur(8px)",
  },
  modal: {
    width: "min(480px, 100%)", maxHeight: "calc(100vh - 32px)", overflowY: "auto",
    padding: "24px", borderRadius: "16px", border: "1px solid rgba(255,255,255,0.12)",
    background: "#171717", boxShadow: "0 24px 80px rgba(0,0,0,0.55)", color: "#f2f2f2",
  },
  headingRow: { display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: "16px" },
  eyebrow: { color: "#e5a00d", fontSize: "10px", fontWeight: 800, letterSpacing: "1.2px" },
  title: { margin: "5px 0 0", fontSize: "22px", lineHeight: 1.2 },
  close: { border: 0, background: "none", color: "#888", fontSize: "28px", lineHeight: 1, cursor: "pointer" },
  copy: { color: "#c4c4c4", fontSize: "14px", lineHeight: 1.55, margin: "20px 0 14px" },
  privacy: { color: "#888", fontSize: "12px", lineHeight: 1.5, margin: "0 0 20px" },
  accountCard: {
    display: "flex", alignItems: "center", gap: "12px", marginTop: "20px", padding: "14px",
    borderRadius: "12px", background: "rgba(229,160,13,0.08)", border: "1px solid rgba(229,160,13,0.2)",
  },
  largeMark: { width: "34px", height: "34px", borderRadius: "8px", fontSize: "19px" },
  accountName: { fontSize: "15px", fontWeight: 700 },
  secondary: { color: "#888", fontSize: "12px", marginTop: "2px" },
  syncStatus: { display: "flex", flexDirection: "column", gap: "6px", color: "#888", fontSize: "12px", marginBottom: "16px" },
  error: { color: "#ef9a9a" },
  actions: { display: "flex", gap: "10px", flexWrap: "wrap" },
  primary: {
    padding: "10px 16px", borderRadius: "9px", border: 0, background: "#e5a00d",
    color: "#171717", fontFamily: "inherit", fontSize: "13px", fontWeight: 800, cursor: "pointer",
  },
  danger: {
    padding: "10px 16px", borderRadius: "9px", border: "1px solid rgba(255,110,110,0.35)",
    background: "transparent", color: "#ef9a9a", fontFamily: "inherit", fontSize: "13px", fontWeight: 700, cursor: "pointer",
  },
  pending: { padding: "14px", borderRadius: "10px", background: "rgba(255,255,255,0.05)", color: "#bbb", fontSize: "13px" },
  link: { display: "inline-block", marginTop: "8px", color: "#e5a00d", fontWeight: 700 },
  message: { marginTop: "16px", color: "#cfcfcf", fontSize: "12px", lineHeight: 1.45 },
};
