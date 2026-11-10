import { LruMap } from "./lru.js";

/**
 * What each recent stream's master playlist told its players about it — the
 * engine, copied or re-encoded and why, its bitrate, its audio — kept by HLS
 * session for the admin page (admin/), so it can say why a stream is
 * re-encoded without asking a player. The same values Stats for nerds reads
 * out of the playlist (routes/plex.ts, streamNotes).
 */
export type StreamNoteValues = Record<string, string | number>;

export interface StreamNotes {
  /** When the playlist was made, Date.now(). */
  at: number;
  values: StreamNoteValues;
}

const notes = new LruMap<string, StreamNotes>(500);

export function rememberStreamNotes(
  sessionId: string,
  values: Record<string, string | number | null>,
  now = Date.now(),
): void {
  const kept: StreamNoteValues = {};
  for (const [k, v] of Object.entries(values)) if (v !== null && v !== "") kept[k] = v;
  notes.set(sessionId, { at: now, values: kept });
}

export function streamNotesOf(sessionId: string): StreamNotes | null {
  return notes.get(sessionId) ?? null;
}
