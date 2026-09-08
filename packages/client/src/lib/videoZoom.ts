export type ZoomMode = "normal" | "fill" | "16:9" | "21:9" | "manual";

export interface ZoomPreference {
  mode: ZoomMode;
  zoom: number;
}

const KEY = "pdt:videoZoom:v1";
const DEFAULT: ZoomPreference = { mode: "normal", zoom: 100 };

function readAll(): Record<string, ZoomPreference> {
  try { return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Record<string, ZoomPreference>; }
  catch { return {}; }
}

export function loadZoomPreference(key: string): ZoomPreference {
  const value = readAll()[key];
  if (!value || !["normal", "fill", "16:9", "21:9", "manual"].includes(value.mode)) return { ...DEFAULT };
  return { mode: value.mode, zoom: Math.max(100, Math.min(200, Math.round(value.zoom / 5) * 5)) };
}

export function saveZoomPreference(key: string, value: ZoomPreference): void {
  try {
    const all = readAll();
    all[key] = { mode: value.mode, zoom: Math.max(100, Math.min(200, Math.round(value.zoom / 5) * 5)) };
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch { /* localStorage may be unavailable in private browsing */ }
}

export function zoomKey(item: { ratingKey: string; type: string; grandparentRatingKey?: string }): string {
  return item.type === "episode" && item.grandparentRatingKey
    ? `show:${item.grandparentRatingKey}`
    : `${item.type}:${item.ratingKey}`;
}
