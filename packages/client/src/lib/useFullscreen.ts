import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

/** Fullscreen is local to this viewer and subject to the embedding client's policy. */
export function useFullscreen(targetRef: RefObject<HTMLDivElement | null>) {
  const [active, setActive] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);

  useEffect(() => {
    const update = () => setActive(document.fullscreenElement === targetRef.current);
    update();
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, [targetRef]);

  const toggle = useCallback(async () => {
    const target = targetRef.current;
    if (!target || pending.current) return;
    setError(null);
    const exiting = document.fullscreenElement === target;
    if (!exiting && (!target.requestFullscreen || !document.fullscreenEnabled)) {
      setError("Fullscreen is unavailable in this view. Try Discord's Activity pop-out, then fullscreen there.");
      return;
    }
    pending.current = true;
    try {
      // Keep this call directly in the click handler's activation context.
      // Fullscreen the wrapper so subtitles and controls remain visible.
      if (exiting) await document.exitFullscreen();
      else await target.requestFullscreen({ navigationUI: "hide" });
    } catch {
      setError(exiting
        ? "Could not exit fullscreen. Try pressing Esc."
        : "Fullscreen was blocked or failed in this view. Try Discord's Activity pop-out, then fullscreen there.");
    } finally {
      pending.current = false;
    }
  }, [targetRef]);

  return { active, error, toggle, dismissError: () => setError(null) };
}
