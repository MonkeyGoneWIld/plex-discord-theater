import { useEffect, useState } from "react";
import { api } from "./api";
import type { PlaceNames } from "./types";

/**
 * Discord servers' and channels' names, by id. Discord gives the bot only
 * ids; the names come from the people who open the Activity — a server's as
 * they sign in, a channel's from the Activity in it — and are kept with the
 * history. Asked for once a minute at most, whichever page wants them.
 */
let known: PlaceNames = { guilds: {}, channels: {} };
let askedAt = 0;
let asking = false;
const listeners = new Set<() => void>();
const FRESH_MS = 60_000;

function ask(): void {
  if (asking || Date.now() - askedAt < FRESH_MS) return;
  asking = true;
  askedAt = Date.now();
  api.names().then((n) => {
    known = n;
    for (const fn of listeners) fn();
  }).catch(() => {
    // Without the history recorded there are none; asked again in a minute.
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
    return () => { listeners.delete(fn); };
  }, []);
  return {
    guild: (id) => (id ? known.guilds[id] ?? null : null),
    channel: (id) => (id ? known.channels[id] ?? null : null),
  };
}
