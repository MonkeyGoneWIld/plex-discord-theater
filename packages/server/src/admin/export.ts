import type { Recorder } from "./recorder.js";

/**
 * The admin page's lists as files: CSV for a spreadsheet, JSON for a script.
 * Each honours the list's search, and holds all of it, not a page.
 */

export const EXPORTS = ["history", "people", "usage", "requests"] as const;
export type ExportKind = (typeof EXPORTS)[number];

const PAGE = 500;
/** Past this many rows a file stops: it says so in its last line (CSV) or `truncated` (JSON). */
export const MAX_EXPORT_ROWS = 200_000;

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : null);

/** Every row of a list kept in pages by id, newest first. */
function* byId<T extends { id: number }>(get: (before: number | undefined) => T[]): Generator<T> {
  let before: number | undefined;
  let n = 0;
  for (;;) {
    const rows = get(before);
    for (const r of rows) {
      if (n++ >= MAX_EXPORT_ROWS) return;
      yield r;
    }
    if (rows.length < PAGE) return;
    before = rows[rows.length - 1].id;
  }
}

/** Every row of a list kept in pages by offset. */
function* byOffset<T>(get: (offset: number) => T[]): Generator<T> {
  for (let offset = 0; offset < MAX_EXPORT_ROWS; offset += PAGE) {
    const rows = get(offset);
    yield* rows.slice(0, MAX_EXPORT_ROWS - offset);
    if (rows.length < PAGE) return;
  }
}

/**
 * One CSV cell. Text a spreadsheet would run as a formula (=, +, -, @, a tab
 * or a return first) is kept as text: Discord names and titles are anybody's.
 */
function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  let s = typeof v === "object" ? JSON.stringify(v) : String(v);
  if (typeof v === "string" && /^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** A CSV file: a byte-order mark, so a spreadsheet reads it as UTF-8, then the rows. */
export function toCsv(header: string[], rows: Iterable<unknown[]>): string {
  const lines = [header.map(cell).join(",")];
  let n = 0;
  for (const r of rows) {
    lines.push(r.map(cell).join(","));
    n++;
  }
  if (n >= MAX_EXPORT_ROWS) lines.push(cell(`Stopped at ${MAX_EXPORT_ROWS} rows`));
  return `﻿${lines.join("\r\n")}\r\n`;
}

function* map<T, U>(it: Iterable<T>, f: (t: T) => U): Generator<U> {
  for (const t of it) yield f(t);
}

export function exportFile(recorder: Recorder, kind: ExportKind, format: "csv" | "json", q: unknown): string {
  const query = typeof q === "string" && q.trim() ? q.trim() : null;
  switch (kind) {
    case "history": {
      const plays = byId((before) => recorder.history({ q: query, before, limit: PAGE }));
      if (format === "json") {
        const all = [...map(plays, (p) => {
          const d = recorder.play(p.id);
          return { ...p, viewers: d?.viewers ?? [], streams: d?.streams ?? [], events: d?.events ?? [] };
        })];
        return json("plays", all, query);
      }
      return toCsv(
        ["id", "started_utc", "ended_utc", "title", "plex_item", "server_id", "channel_id", "room", "host_id", "host_name",
          "viewers", "viewer_names", "played_s", "from_s", "to_s", "most_watching", "streams", "reencoded", "bytes",
          "stalls", "end_reason", "ended_by"],
        map(plays, (p) => [p.id, iso(p.startedAt), iso(p.endedAt), p.title, p.ratingKey, p.guildId, p.channelId, p.roomId,
          p.hostUserId, p.hostName, p.viewers, p.names.join("; "), Math.round(p.playedS), p.startPosS, p.lastPosS,
          p.peakViewers, p.streams, p.reencoded, p.bytes, p.stalls, p.endReason, p.endBy]),
      );
    }
    case "people": {
      const people = byOffset((offset) => recorder.people({ q: query, offset, limit: PAGE }));
      if (format === "json") return json("people", [...people], query);
      return toCsv(
        ["user_id", "username", "first_seen_utc", "last_seen_utc", "plays", "hosted", "launches", "requests", "watched_s",
          "bytes", "from_bot_bytes", "discord_cache_bytes", "other_viewers_bytes", "stalls", "stalled_ms", "player_errors",
          "last_title"],
        map(people, (p) => [p.userId, p.username, iso(p.firstSeen), iso(p.lastSeen), p.plays, p.hosted, p.launches,
          p.requests, Math.round(p.watchedS), p.httpBytes + p.p2pBytes, p.botBytes, p.edgeHitBytes, p.p2pBytes, p.stalls,
          p.stalledMs, p.errors, p.lastTitle]),
      );
    }
    case "usage": {
      const usage = byId((before) => recorder.usage({ before, limit: PAGE }));
      if (format === "json") return json("usage", [...usage], null);
      return toCsv(["id", "at_utc", "what", "user_id", "username", "server_id", "channel_id", "room"],
        map(usage, (u) => [u.id, iso(u.at), u.kind, u.userId, u.username, u.guildId, u.channelId, u.roomId]));
    }
    case "requests": {
      const requests = byId((before) => recorder.requests({ q: query, before, limit: PAGE }));
      if (format === "json") return json("requests", [...requests], query);
      return toCsv(["id", "at_utc", "user_id", "username", "type", "tmdb_id", "title", "seasons", "outcome", "status", "error"],
        map(requests, (r) => [r.id, iso(r.at), r.userId, r.username, r.mediaType, r.tmdbId, r.title,
          Array.isArray(r.seasons) ? r.seasons.join(" ") : r.seasons, r.outcome, r.status, r.error]));
    }
  }
}

function json(key: string, rows: unknown[], q: string | null): string {
  return JSON.stringify({ exportedAt: new Date().toISOString(), search: q, truncated: rows.length >= MAX_EXPORT_ROWS, [key]: rows }, null, 1);
}

/** `theater-history-20261110-1405.csv`: what, and when (UTC). */
export function exportName(kind: string, ext: string, at = new Date()): string {
  const stamp = at.toISOString().slice(0, 16).replace(/[-:]/g, "").replace("T", "-");
  return `theater-${kind}-${stamp}.${ext}`;
}
