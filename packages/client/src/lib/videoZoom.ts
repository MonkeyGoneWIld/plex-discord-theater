export type ZoomMode = "normal" | "fill" | "16:9" | "21:9" | "width" | "height" | "manual";

export interface ZoomPreference {
  mode: ZoomMode;
  zoom: number;
}

const KEY = "pdt:videoZoom:v1";
const DEFAULT: ZoomPreference = { mode: "normal", zoom: 100 };

function readAll(): Record<string, ZoomPreference> {
  try { const value = JSON.parse(localStorage.getItem(KEY) ?? "{}"); return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
  catch { return {}; }
}

export function loadZoomPreference(key: string): ZoomPreference {
  const value = readAll()[key];
  if (!value || !["normal", "fill", "16:9", "21:9", "width", "height", "manual"].includes(value.mode)) return { ...DEFAULT };
  return { mode: value.mode, zoom: Math.max(50, Math.min(200, Math.round((Number.isFinite(value.zoom) ? value.zoom : 100) / 5) * 5)) };
}

export function saveZoomPreference(key: string, value: ZoomPreference): void {
  try {
    const all = readAll();
    all[key] = { mode: value.mode, zoom: Math.max(50, Math.min(200, Math.round((Number.isFinite(value.zoom) ? value.zoom : 100) / 5) * 5)) };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* localStorage may be unavailable in private browsing */ }
}

export function zoomKey(item: { ratingKey: string; type: string; grandparentRatingKey?: string }): string {
  return item.type === "episode" && item.grandparentRatingKey
    ? `show:${item.grandparentRatingKey}`
    : `${item.type}:${item.ratingKey}`;
}

/** Scale a contained picture to exactly reach the requested window dimension. */
export function axisZoomScale(mode: ZoomMode, width: number, height: number, videoWidth: number, videoHeight: number): number {
  if (width <= 0 || height <= 0 || videoWidth <= 0 || videoHeight <= 0) return 1;
  const windowRatio = width / height;
  const videoRatio = videoWidth / videoHeight;
  if (mode === "width") return Math.max(1, windowRatio / videoRatio);
  if (mode === "height") return Math.max(1, videoRatio / windowRatio);
  return 1;
}