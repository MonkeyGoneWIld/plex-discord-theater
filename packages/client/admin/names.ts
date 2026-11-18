import { useEffect, useState } from "react";
import { api } from "./api";
import type { PlaceNames } from "./types";

/**
 * Discord servers' and channels' names, by id. Discord gives the bot only
 * ids; the names come from the people who open the Activity — a server's as
 * they sign in, a channel's from the Activity in it — and are kept with the
 * history.
 *
 * Asked for again every 15 seconds while a page shows them, and within 5 of
 * one being shown without a name. They used to be asked for only as a page
 * opened, so Activity, which stays open, showed a new channel's ID until
 * the page was left and opened again.
 */
let known: PlaceNames = { guilds: {}, channels: {} };
let askedAt = 0;
let asking = false;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();
const FRESH_MS = 15_000;
const UNKNOWN_MS = 5_000;

function ask(within = FRESH_MS): void {
  if (asking || Date.now() - askedAt < within) return;
  asking = true;
  askedAt = Date.now();
  api.names().then((n) => {
    known = n;
    for (const fn of listeners) fn();
  }).catch(() => {
    // Without the history recorded there are none; asked again shortly.
  }).finally(() => { asking = false; });
}

export interface Names {
  guild(id: string | null | undefined): string | null;
  channel(id: string | null | undefined): string | null;
}

export function usePlaceNames(): Names {
  const [, tick] = useState(0);
  useEffect(() => {
    const fn = () => tick((n) => n + 1);
    listeners.add(fn);
    ask();
    timer ??= setInterval(() => ask(), FRESH_MS);
    return () => {
      listeners.delete(fn);
      if (listeners.size === 0 && timer) {
        clearInterval(timer);
        timer = null;
      }
    };
  }, []);
  const name = (list: Record<string, string>, id: string | null | undefined) => {
    if (!id) return null;
    const n = list[id];
    if (!n) ask(UNKNOWN_MS);
    return n ?? null;
  };
  return {
    guild: (id) => name(known.guilds, id),
    channel: (id) => name(known.channels, id),
  };
}
