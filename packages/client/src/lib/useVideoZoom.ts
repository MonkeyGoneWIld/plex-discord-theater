import { useEffect, useRef, useState, type RefObject } from "react";
import { loadZoomPreference, saveZoomPreference, type ZoomMode } from "./videoZoom";

export function useVideoZoom(root: RefObject<HTMLDivElement | null>, key: string | null) {
  const [revision, render] = useState(0);
  const state = useRef({ key, ...loadZoomPreference(key ?? ""), x: 0, y: 0 });
  if (key !== state.current.key) {
    state.current = { key, ...loadZoomPreference(key ?? ""), x: 0, y: 0 };
  }
  const update = (mode: ZoomMode, zoom = state.current.zoom, x = state.current.x, y = state.current.y) => {
    const value = Math.max(50, Math.min(200, Math.round(zoom / 5) * 5));
    state.current = { key: state.current.key, mode, zoom: value, x: value <= 100 ? 0 : x, y: value <= 100 ? 0 : y };
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
      if (e.deltaY) updateRef.current("manual", state.current.zoom + (e.deltaY < 0 ? 5 : -5));
    };
    let gesture: { distance: number; zoom: number; cx: number; cy: number; x: number; y: number } | null = null;
    let suppressUntil = 0;
    const measure = (touches: TouchList) => {
      const a = touches[0], b = touches[1] ?? a;
      return { distance: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY), cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2 };
    };
    const start = (e: TouchEvent) => {
      if (e.touches.length === 1) suppressUntil = 0;
      if (!surface(e.target, e.touches[0]?.clientY ?? 0)) return;
      if (e.touches.length === 2 || (state.current.mode === "manual" && state.current.zoom > 100)) {
        gesture = { ...measure(e.touches), zoom: state.current.zoom, x: state.current.x, y: state.current.y };
        if (e.touches.length === 2) { e.preventDefault(); suppressUntil = Date.now() + 700; }
      }
    };
    const move = (e: TouchEvent) => {
      if (!gesture || !e.touches.length) return;
      const m = measure(e.touches);
      // Small finger motion during a tap is not an intentional pan.
      if (e.touches.length === 1 && Math.hypot(m.cx - gesture.cx, m.cy - gesture.cy) < 6) return;
      e.preventDefault();
      e.stopPropagation();
      suppressUntil = Date.now() + 700;
      const ratio = gesture.distance > 0 && e.touches.length === 2 ? m.distance / gesture.distance : 1;
      if (state.current.mode === "manual") {
        const zoom = Math.max(50, Math.min(200, Math.round(gesture.zoom * ratio / 5) * 5));
        const box = el.getBoundingClientRect();
        const video = el.querySelector("video");
        const fit = video?.videoWidth && video.videoHeight
          ? Math.min(box.width / video.videoWidth, box.height / video.videoHeight) : 1;
        const width = video?.videoWidth ? video.videoWidth * fit : box.width;
        const height = video?.videoHeight ? video.videoHeight * fit : box.height;
        const maxX = Math.max(0, (width * zoom / 100 - box.width) / 2);
        const maxY = Math.max(0, (height * zoom / 100 - box.height) / 2);
        updateRef.current("manual", zoom,
          Math.max(-maxX, Math.min(maxX, gesture.x + m.cx - gesture.cx)),
          Math.max(-maxY, Math.min(maxY, gesture.y + m.cy - gesture.cy)));
      } else if (ratio > 1.08) updateRef.current("fill");
      else if (ratio < 0.92) updateRef.current("normal");
    };
    const end = (e: TouchEvent) => {
      if (e.touches.length === 0) gesture = null;
      else if (gesture) gesture = { ...measure(e.touches), zoom: state.current.zoom, x: state.current.x, y: state.current.y };
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
  return { ...state.current, setMode: (mode: ZoomMode) => update(mode, mode === "manual" ? 100 : state.current.zoom, 0, 0), setZoom: (zoom: number) => update("manual", zoom) };
}
