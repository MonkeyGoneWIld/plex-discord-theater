import { useEffect, useRef, useState, type RefObject } from "react";
import { loadZoomPreference, saveZoomPreference, type ZoomMode } from "./videoZoom";

export function useVideoZoom(root: RefObject<HTMLDivElement | null>, key: string | null, onGesture?: (message: string) => void) {
  const gestureNotice = useRef(onGesture);
  gestureNotice.current = onGesture;
  const [revision, render] = useState(0);
  const state = useRef({ key, ...loadZoomPreference(key ?? "") });
  if (key !== state.current.key) {
    state.current = { key, ...loadZoomPreference(key ?? "") };
  }
  const update = (mode: ZoomMode, zoom = state.current.zoom) => {
    const value = Math.max(50, Math.min(200, Math.round(zoom / 5) * 5));
    state.current = { key: state.current.key, mode, zoom: value };
    if (state.current.key) saveZoomPreference(state.current.key, state.current);
    render((v) => v + 1);
  };
  const updateRef = useRef(update);
  updateRef.current = update;
  useEffect(() => {
    const el = root.current;
    if (!el) return;
    const surface = (target: EventTarget | null, y: number) => {
      const hit = target as HTMLElement;
      const bar = el.querySelector("[data-player-progress]")?.getBoundingClientRect();
      return hit?.matches?.("video, [data-zoom-surface], [data-scrim]") && (!bar || y < bar.top);
    };
    const wheel = (e: WheelEvent) => {
      if (!e.ctrlKey || state.current.mode !== "manual" || !surface(e.target, e.clientY)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.deltaY) {
        updateRef.current("manual", state.current.zoom + (e.deltaY < 0 ? 5 : -5));
        gestureNotice.current?.(`Zoom: ${state.current.zoom}%`);
      }
    };
    let gesture: { distance: number; zoom: number } | null = null;
    let suppressUntil = 0;
    const measure = (touches: TouchList) => {
      const a = touches[0], b = touches[1] ?? a;
      return { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) };
    };
    const start = (e: TouchEvent) => {
      if (e.touches.length === 1) suppressUntil = 0;
      if (!surface(e.target, e.touches[0]?.clientY ?? 0)) return;
      if (e.touches.length === 2) {
        gesture = { ...measure(e.touches), zoom: state.current.zoom };
        if (e.touches.length === 2) { e.preventDefault(); suppressUntil = Date.now() + 700; }
      }
    };
    const move = (e: TouchEvent) => {
      if (!gesture || e.touches.length !== 2) return;
      const m = measure(e.touches);
      e.preventDefault();
      e.stopPropagation();
      suppressUntil = Date.now() + 700;
      const ratio = gesture.distance > 0 && e.touches.length === 2 ? m.distance / gesture.distance : 1;
      if (state.current.mode === "manual") {
        const zoom = Math.max(50, Math.min(200, Math.round(gesture.zoom * ratio / 5) * 5));
        updateRef.current("manual", zoom);
        if (e.touches.length === 2) gestureNotice.current?.(`Zoom: ${state.current.zoom}%`);
      } else if (ratio > 1.08 && state.current.mode !== "fill") {
        updateRef.current("fill");
        gestureNotice.current?.("Fill Screen");
      } else if (ratio < 0.92 && state.current.mode !== "normal") {
        updateRef.current("normal");
        gestureNotice.current?.("Normal");
      }
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length !== 2) gesture = null;
      else if (gesture) gesture = { ...measure(e.touches), zoom: state.current.zoom };
    };
    const click = (e: MouseEvent) => {
      if (Date.now() < suppressUntil && surface(e.target, e.clientY)) { e.preventDefault(); e.stopPropagation(); }
    };
    el.addEventListener("wheel", wheel, { passive: false, capture: true });
    el.addEventListener("touchstart", start, { passive: false, capture: true });
    el.addEventListener("touchmove", move, { passive: false, capture: true });
    el.addEventListener("touchend", end, true);
    el.addEventListener("touchcancel", end, true);
    el.addEventListener("click", click, true);
    return () => {
      el.removeEventListener("wheel", wheel, true);
      el.removeEventListener("touchstart", start, true);
      el.removeEventListener("touchmove", move, true);
      el.removeEventListener("touchend", end, true);
      el.removeEventListener("touchcancel", end, true);
      el.removeEventListener("click", click, true);
    };
  }, [root]);
  void revision;
  return { ...state.current, setMode: (mode: ZoomMode) => update(mode, mode === "manual" ? 100 : state.current.zoom), setZoom: (zoom: number) => update("manual", zoom) };
}
