import { useEffect, useState } from "react";
import { api } from "./api";
import type { TitleInfo } from "./types";
import { Icon } from "./icons";

/**
 * Posters and running times, by Plex item. Asked for once a page and kept:
 * the live feed names the same few titles every two seconds.
 */
const known = new Map<string, TitleInfo | null>();
const asked = new Set<string>();
const listeners = new Set<() => void>();

function ask(keys: string[]): void {
  const need = keys.filter((k) => /^\d+$/.test(k) && !asked.has(k));
  if (need.length === 0) return;
  for (const k of need) asked.add(k);
  for (let i = 0; i < need.length; i += 60) {
    const batch = need.slice(i, i + 60);
    api.titles(batch).then((r) => {
      for (const k of batch) known.set(k, r.titles[k] ?? null);
      for (const fn of listeners) fn();
    }).catch(() => {
      // Asked again the next time the page wants them.
      for (const k of batch) asked.delete(k);
    });
  }
}

/** What is known of each title so far; the page draws again as the rest arrive. */
export function useTitles(keys: Array<string | null | undefined>): (key: string | null | undefined) => TitleInfo | null {
  const [, tick] = useState(0);
  const wanted = [...new Set(keys.filter((k): k is string => !!k))].sort().join(",");
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    listeners.add(fn);
    if (wanted) ask(wanted.split(","));
    return () => { listeners.delete(fn); };
  }, [wanted]);
  return (key) => (key ? known.get(key) ?? null : null);
}

/** A title's poster, or a plain tile where Plex has none (or the title is gone). */
export function Poster({ ratingKey, title, size = "md" }: { ratingKey: string | null; title?: string | null; size?: "sm" | "md" | "lg" }) {
  const [failed, setFailed] = useState<string | null>(null);
  const none = !ratingKey || failed === ratingKey;
  return (
    <div className={`poster ${size}${none ? " none" : ""}`}>
      {none
        ? <Icon name="film" size={size === "sm" ? 18 : 28} />
        : <img src={`/api/poster/${encodeURIComponent(ratingKey)}`} alt={title ? `Poster of ${title}` : ""} loading="lazy"
          onError={() => setFailed(ratingKey)} />}
    </div>
  );
}

/** "2019", "Season 1 · Episode 3", or nothing. */
export function titleLine(info: TitleInfo | null): string | null {
  if (!info) return null;
  if (info.type === "episode") {
    const parts = [info.season !== null ? `Season ${info.season}` : null, info.episode !== null ? `Episode ${info.episode}` : null].filter(Boolean);
    return parts.length ? parts.join(" · ") : null;
  }
  return info.year ? String(info.year) : null;
}
