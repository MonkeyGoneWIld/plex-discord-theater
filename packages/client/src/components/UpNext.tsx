import { useState, useEffect, useRef, useCallback } from "react";
import { formatMediaTitle } from "../lib/format";
import type { QueueItem } from "../hooks/useSync";

interface UpNextProps {
  item: QueueItem;
  onPlayNow: () => void;
  onCancel: () => void;
}

const COUNTDOWN_SECONDS = 15;

export function UpNext({ item, onPlayNow, onCancel }: UpNextProps) {
  const [remaining, setRemaining] = useState(COUNTDOWN_SECONDS);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const firedRef = useRef(false);
  const onPlayNowRef = useRef(onPlayNow);
  onPlayNowRef.current = onPlayNow;

  const fire = useCallback(() => {
    if (firedRef.current) return;
    firedRef.current = true;
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    onPlayNowRef.current();
  }, []);

  useEffect(() => {
    firedRef.current = false;
    intervalRef.current = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          fire();
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [fire]);

  const title = formatMediaTitle(item);

  return (
    <div style={styles.container}>
      <div style={styles.label}>UP NEXT</div>
      <div style={styles.title}>{title}</div>
      <div style={styles.countdown}>Playing in {remaining}s</div>
      <div style={styles.buttons}>
        <button onClick={fire} style={styles.playNowBtn}>Play Now</button>
        <button onClick={onCancel} style={styles.cancelBtn}>Cancel</button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { position: "absolute", bottom: "80px", right: "20px", zIndex: 30, background: "rgba(0,0,0,0.85)", backdropFilter: "blur(12px)", borderRadius: "12px", padding: "16px 20px", maxWidth: "280px", border: "1px solid rgba(255,255,255,0.1)" },
  label: { color: "#e5a00d", fontSize: "10px", fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase", marginBottom: "6px" },
  title: { color: "#f0f0f0", fontSize: "14px", fontWeight: 600, marginBottom: "4px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  countdown: { color: "#888", fontSize: "12px", marginBottom: "12px" },
  buttons: { display: "flex", gap: "8px" },
  playNowBtn: { flex: 1, padding: "8px", borderRadius: "6px", border: "none", background: "#e5a00d", color: "#000", fontSize: "12px", fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  cancelBtn: { flex: 1, padding: "8px", borderRadius: "6px", border: "1px solid rgba(255,255,255,0.15)", background: "transparent", color: "#888", fontSize: "12px", cursor: "pointer", fontFamily: "inherit" },
};
