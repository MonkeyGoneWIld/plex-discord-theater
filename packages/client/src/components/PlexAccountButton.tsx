import { useCallback, useEffect, useRef, useState } from "react";
import plexMark from "../assets/plex-mark.svg";
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
  onOpenExternalLink: (url: string) => Promise<boolean>;
}

const AUTO_SYNC_AFTER_MS = 15 * 60 * 1000;

function when(value: number | null): string {
  if (!value) return "Not synced yet";
  return `Last synced ${new Date(value).toLocaleString()}`;
}

function historyItems(count: number): string {
  return `${count} history ${count === 1 ? "item" : "items"}`;
}

export function PlexAccountButton({ compact = false, onHistoryChanged, onOpenExternalLink }: PlexAccountButtonProps) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<PlexAccountStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const autoSyncStarted = useRef(false);

  const runSync = useCallback(async (quiet = false) => {
    setBusy(true);
    if (!quiet) setMessage(null);
    try {
      const result = await syncPlexAccount();
      setStatus(result.status);
      setMessage(
        `Imported ${historyItems(result.imported)} from your Plex account into this Discord Activity. `
        + `Sent ${historyItems(result.exported)} from this Discord Activity to your Plex account.`,
      );
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
    let checking = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const next = await pollPlexAccountLink();
        if (cancelled) return;
        setStatus(next);
        if (next.linked) {
          setMessage(`Linked ${next.account?.username ?? "Plex account"}. Importing history...`);
          await runSync();
        }
      } catch (err) {
        if (!cancelled) {
          setMessage(err instanceof Error ? err.message : "Could not finish Plex sign-in");
          // The server may have completed the link before a proxy/network error
          // reached this poll, or removed a consumed PIN after a permanent
          // validation failure. Re-read authoritative state so the modal never
          // leaves the user guessing whether the account linked.
          fetchPlexAccountStatus().then((next) => {
            if (!cancelled) setStatus(next);
          }).catch(() => {});
        }
      } finally {
        checking = false;
      }
    };
    const timer = window.setInterval(() => void check(), 2000);
    void check();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [status?.pending?.authUrl, status?.linked, runSync]);

  const openPlex = useCallback(async (url: string): Promise<boolean> => {
    if (await onOpenExternalLink(url)) return true;
    return window.open(url, "_blank", "noopener,noreferrer") !== null;
  }, [onOpenExternalLink]);

  const beginLink = async () => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await startPlexAccountLink();
      setStatus(next);
      if (next.pending?.authUrl) {
        const opened = await openPlex(next.pending.authUrl);
        setMessage(opened
          ? "Finish signing in on Plex. This window will update automatically."
          : "Discord couldn't open Plex. Use Open Plex sign-in below to try again.");
      }
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not start Plex sign-in");
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setMessage(null);
    try {
      await unlinkPlexAccount();
      setStatus({ linked: false, lastSyncAt: null, lastSyncError: null });
      setConfirmDisconnect(false);
      autoSyncStarted.current = false;
      setMessage("Plex account disconnected. Local history was kept.");
      onHistoryChanged?.();
    } catch (err) {
      setMessage(err instanceof Error ? err.message : "Could not disconnect Plex");
    } finally {
      setBusy(false);
    }
  };

  const closeModal = () => {
    setOpen(false);
    setConfirmDisconnect(false);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        style={{ ...styles.trigger, ...(status?.linked ? styles.triggerLinked : {}) }}
        title={status?.linked ? `Plex linked as ${status.account?.username}` : "Link Plex account"}
      >
        <span style={{ ...styles.plexMark, ...(!status?.linked ? styles.plexMarkUnlinked : {}) }}>
          <img
            src={plexMark}
            alt=""
            style={{ ...styles.plexMarkImage, ...(!status?.linked ? styles.plexMarkImageUnlinked : {}) }}
          />
        </span>
        {!compact && <span>{status?.linked ? "Plex linked" : "Link Plex"}</span>}
      </button>

      {open && (
        <div style={styles.overlay} role="presentation" onMouseDown={(e) => {
          if (e.target === e.currentTarget) closeModal();
        }}>
          <section style={styles.modal} role="dialog" aria-modal="true" aria-labelledby="plex-account-title">
            <div style={styles.headingRow}>
              <h2 id="plex-account-title" style={styles.title}>Account sync</h2>
              <button type="button" onClick={closeModal} style={styles.close} aria-label="Close">&times;</button>
            </div>

            {status?.linked ? (
              <>
                <div style={styles.accountCard}>
                  <span style={{ ...styles.plexMark, ...styles.largeMark }}>
                    <img src={plexMark} alt="" style={styles.plexMarkImage} />
                  </span>
                  <div>
                    <div style={styles.accountName}>{status.account?.username}</div>
                    <div style={styles.secondary}>{status.account?.email || "Plex account connected"}</div>
                  </div>
                </div>
                <p style={styles.copy}>
                  Progress from this Activity is sent to your Plex account. Your complete Plex watch history and current resume positions are imported here. Every participant links and syncs independently.
                </p>
                <div style={styles.syncStatus}>
                  <span>{when(status.lastSyncAt)}</span>
                  {status.lastSyncError && <span style={styles.error}>{status.lastSyncError}</span>}
                </div>
                <div style={styles.actions}>
                  <button type="button" disabled={busy || confirmDisconnect} onClick={() => void runSync()} style={styles.primary}>
                    {busy ? "Syncing..." : "Sync now"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => setConfirmDisconnect(true)} style={styles.danger}>
                    Disconnect
                  </button>
                </div>
                {confirmDisconnect && (
                  <div style={styles.disconnectConfirm} role="alert">
                    <div style={styles.confirmTitle}>Disconnect this Plex account?</div>
                    <div style={styles.secondary}>
                      Local Activity history is kept for this account, but will reset if you link a different Plex account.
                    </div>
                    <div style={styles.confirmActions}>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => setConfirmDisconnect(false)}
                        style={styles.secondaryButton}
                      >
                        Keep linked
                      </button>
                      <button type="button" disabled={busy} onClick={() => void disconnect()} style={styles.dangerFilled}>
                        {busy ? "Disconnecting..." : "Yes, disconnect"}
                      </button>
                    </div>
                  </div>
                )}
              </>
            ) : (
              <>
                <p style={styles.copy}>
                  Link your own Plex account to sync your complete watch history and resume positions in both directions. During a watch party, every linked participant who has the player open receives credit on their own account.
                </p>
                <p style={styles.privacy}>
                  You sign in directly on plex.tv. Your password never reaches this app, and the resulting account token is encrypted and stored only on the server.
                </p>
                {status?.pending ? (
                  <div style={styles.pending}>
                    <div>Waiting for Plex authorization...</div>
                    <button
                      type="button"
                      onClick={() => void openPlex(status.pending!.authUrl)}
                      style={styles.linkButton}
                    >
                      Open Plex sign-in again
                    </button>
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
    borderRadius: "999px", border: "1px solid rgba(255,255,255,0.10)",
    background: "transparent", color: "#9a9a9a", cursor: "pointer",
    fontFamily: "inherit", fontSize: "12px", fontWeight: 600, whiteSpace: "nowrap",
    transition: "border-color 0.15s ease, color 0.15s ease, background 0.15s ease",
  },
  triggerLinked: {
    color: "#e5a00d", border: "1px solid rgba(229,160,13,0.3)",
    background: "rgba(255,255,255,0.05)",
  },
  plexMark: {
    display: "inline-flex", alignItems: "center", justifyContent: "center",
    width: "17px", height: "17px", borderRadius: "4px", background: "#111",
    border: "1px solid rgba(229,160,13,0.38)", boxSizing: "border-box", overflow: "hidden",
  },
  plexMarkUnlinked: { borderColor: "rgba(255,255,255,0.16)" },
  plexMarkImage: { display: "block", width: "100%", height: "100%" },
  plexMarkImageUnlinked: { filter: "grayscale(1)", opacity: 0.72 },
  overlay: {
    position: "fixed", inset: 0, zIndex: 10000, display: "flex", alignItems: "center",
    justifyContent: "center", padding: "20px", background: "rgba(0,0,0,0.6)",
  },
  modal: {
    width: "min(480px, 100%)", maxHeight: "calc(100vh - 32px)", overflowY: "auto",
    padding: "20px", borderRadius: "12px", border: "1px solid rgba(255,255,255,0.1)",
    background: "rgba(13,13,13,0.95)", backdropFilter: "blur(20px)",
    boxShadow: "0 20px 64px rgba(0,0,0,0.5)", color: "#f0f0f0",
  },
  headingRow: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: "16px" },
  title: { margin: 0, color: "#f0f0f0", fontSize: "15px", fontWeight: 600, lineHeight: 1.2 },
  close: {
    width: "28px", height: "28px", borderRadius: "50%", border: 0,
    background: "rgba(255,255,255,0.08)", color: "#aaa", fontSize: "18px", lineHeight: 1,
    cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "inherit",
  },
  copy: { color: "#c4c4c4", fontSize: "14px", lineHeight: 1.55, margin: "18px 0 14px" },
  privacy: { color: "#888", fontSize: "12px", lineHeight: 1.5, margin: "0 0 20px" },
  accountCard: {
    display: "flex", alignItems: "center", gap: "12px", marginTop: "20px", padding: "14px",
    borderRadius: "8px", background: "rgba(229,160,13,0.08)", border: "1px solid rgba(229,160,13,0.2)",
  },
  largeMark: { width: "34px", height: "34px", borderRadius: "8px", fontSize: "19px" },
  accountName: { fontSize: "15px", fontWeight: 700 },
  secondary: { color: "#888", fontSize: "12px", marginTop: "2px" },
  syncStatus: { display: "flex", flexDirection: "column", gap: "6px", color: "#888", fontSize: "12px", marginBottom: "16px" },
  error: { color: "#ef9a9a" },
  actions: { display: "flex", gap: "10px", flexWrap: "wrap" },
  primary: {
    padding: "9px 14px", borderRadius: "8px", border: 0, background: "#e5a00d",
    color: "#171717", fontFamily: "inherit", fontSize: "12px", fontWeight: 700, cursor: "pointer",
  },
  danger: {
    padding: "9px 14px", borderRadius: "8px", border: "1px solid rgba(255,110,110,0.35)",
    background: "transparent", color: "#ef9a9a", fontFamily: "inherit", fontSize: "12px", fontWeight: 600, cursor: "pointer",
  },
  disconnectConfirm: {
    marginTop: "14px", padding: "14px", borderRadius: "10px",
    border: "1px solid rgba(255,110,110,0.28)", background: "rgba(255,110,110,0.07)",
  },
  confirmTitle: { marginBottom: "4px", color: "#f4d0d0", fontSize: "13px", fontWeight: 700 },
  confirmActions: { display: "flex", gap: "8px", marginTop: "12px", flexWrap: "wrap" },
  secondaryButton: {
    padding: "9px 13px", borderRadius: "8px", border: "1px solid rgba(255,255,255,0.15)",
    background: "rgba(255,255,255,0.05)", color: "#ccc", fontFamily: "inherit", fontSize: "12px", fontWeight: 700, cursor: "pointer",
  },
  dangerFilled: {
    padding: "9px 13px", borderRadius: "8px", border: 0, background: "#c94f4f",
    color: "#fff", fontFamily: "inherit", fontSize: "12px", fontWeight: 800, cursor: "pointer",
  },
  pending: { padding: "14px", borderRadius: "10px", background: "rgba(255,255,255,0.05)", color: "#bbb", fontSize: "13px" },
  linkButton: {
    display: "block", marginTop: "8px", padding: 0, border: 0, background: "none",
    color: "#e5a00d", fontFamily: "inherit", fontSize: "13px", fontWeight: 700,
    textDecoration: "underline", cursor: "pointer",
  },
  message: { marginTop: "16px", color: "#cfcfcf", fontSize: "12px", lineHeight: 1.45 },
};
