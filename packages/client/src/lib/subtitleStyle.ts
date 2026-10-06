import { useSyncExternalStore } from "react";

/**
 * How this viewer likes the subtitles the player draws itself to look.
 *
 * Only those: a burned-in subtitle is part of the picture, and nothing here
 * reaches it. Saved on this device, for every title — unlike the timing
 * offset, which belongs to one badly-timed release, a size or a colour is
 * about the person watching. Storage is wrapped like every other use of it
 * here: inside a Discord Activity iframe it can be unavailable or throw, and
 * then the choice lasts as long as the page does.
 */
export type SubtitleColor = "white" | "yellow" | "cyan" | "green" | "pink";
export type SubtitleBackground = "outline" | "shadow" | "box";
export type SubtitleFont = "sans" | "serif";

export interface SubtitleStyle {
  /** Text size, percent of the default — which matches a burned-in subtitle. */
  size: number;
  color: SubtitleColor;
  /** How the text stands off the picture: an outline, a drop shadow, or a box. */
  background: SubtitleBackground;
  /** How far the bottom lines sit above where they would, in percent of the
   *  picture's height. Negative lowers them. */
  raise: number;
  bold: boolean;
  font: SubtitleFont;
}

export const DEFAULT_SUBTITLE_STYLE: SubtitleStyle = {
  size: 100,
  color: "white",
  background: "outline",
  raise: 0,
  bold: false,
  font: "sans",
};

export const SUBTITLE_SIZE = { min: 60, max: 200, step: 10 };
export const SUBTITLE_RAISE = { min: -4, max: 30, step: 2 };

export const SUBTITLE_COLORS: Record<SubtitleColor, { label: string; css: string }> = {
  white: { label: "White", css: "#ffffff" },
  yellow: { label: "Yellow", css: "#ffe14d" },
  cyan: { label: "Cyan", css: "#6fe7ff" },
  green: { label: "Green", css: "#7dff8a" },
  pink: { label: "Pink", css: "#ff9de2" },
};

export const SUBTITLE_STYLE_KEY = "pdt:subtitleStyle:v1";

const clamp = (n: unknown, { min, max, step }: { min: number; max: number; step: number }, fallback: number) => {
  const v = Number(n);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v / step) * step));
};

/** A stored or proposed style, with anything out of range or unknown put back
 *  to its default. */
export function normaliseSubtitleStyle(raw: unknown): SubtitleStyle {
  const s = (raw && typeof raw === "object" ? raw : {}) as Partial<Record<keyof SubtitleStyle, unknown>>;
  const d = DEFAULT_SUBTITLE_STYLE;
  return {
    size: clamp(s.size, SUBTITLE_SIZE, d.size),
    color: typeof s.color === "string" && s.color in SUBTITLE_COLORS ? s.color as SubtitleColor : d.color,
    background: s.background === "shadow" || s.background === "box" || s.background === "outline" ? s.background : d.background,
    raise: clamp(s.raise, SUBTITLE_RAISE, d.raise),
    bold: typeof s.bold === "boolean" ? s.bold : d.bold,
    font: s.font === "serif" || s.font === "sans" ? s.font : d.font,
  };
}

function load(): SubtitleStyle {
  try {
    const raw = localStorage.getItem(SUBTITLE_STYLE_KEY);
    return normaliseSubtitleStyle(raw ? JSON.parse(raw) : null);
  } catch {
    return { ...DEFAULT_SUBTITLE_STYLE };
  }
}

let current: SubtitleStyle | null = null;
const listeners = new Set<() => void>();

export function subtitleStyle(): SubtitleStyle {
  current ??= load();
  return current;
}

/** Change some of it — from what it is now, when given a function, so presses
 *  quicker than a render each count. */
export function setSubtitleStyle(
  change: Partial<SubtitleStyle> | ((now: SubtitleStyle) => Partial<SubtitleStyle>),
): void {
  const now = subtitleStyle();
  const next = normaliseSubtitleStyle({ ...now, ...(typeof change === "function" ? change(now) : change) });
  current = next;
  try {
    if (isDefaultSubtitleStyle(next)) localStorage.removeItem(SUBTITLE_STYLE_KEY);
    else localStorage.setItem(SUBTITLE_STYLE_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable: the choice lasts until the page goes.
  }
  for (const fn of listeners) fn();
}

/** Forget the saved style — see resetSavedSettings — so the next read starts
 *  from the defaults. */
export function forgetSubtitleStyle(): void {
  current = null;
  for (const fn of listeners) fn();
}

export function isDefaultSubtitleStyle(s: SubtitleStyle): boolean {
  const d = DEFAULT_SUBTITLE_STYLE;
  return s.size === d.size && s.color === d.color && s.background === d.background &&
    s.raise === d.raise && s.bold === d.bold && s.font === d.font;
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useSubtitleStyle(): SubtitleStyle {
  return useSyncExternalStore(subscribe, subtitleStyle, subtitleStyle);
}
