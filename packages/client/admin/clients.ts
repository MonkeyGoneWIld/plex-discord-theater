/**
 * Which client a viewer watched on: the Discord app or a browser, and on what
 * system, from the user agent its player gave on joining (server sync.ts
 * RoomClient.device); and the clients a viewer moved between in a session.
 */
import type { PlayEvent } from "./types";

/** What a player can decode (ffmpeg/plan.ts, PLAYER_CAPS), by name. */
export const CAP_LABELS: Record<string, string> = {
  hevc: "HEVC", av1: "AV1", vp9: "VP9", opus: "Opus", flac: "FLAC", ac3: "AC3", eac3: "E-AC3",
  hdr: "HDR", tenBit: "10-bit", uhd: "4K", hi10: "10-bit H.264",
};

/** A player's formats beyond H.264 and AAC, in words. */
export function formatsText(caps: unknown, av1Encode = false): string {
  const list = Array.isArray(caps) ? caps.map((c) => CAP_LABELS[String(c)] ?? String(c)) : [];
  return `${list.length ? list.join(", ") : "H.264 and AAC only"}${av1Encode ? " · AV1 encoding" : ""}`;
}

function systemOf(ua: string): string | null {
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  if (/Windows/.test(ua)) return "Windows";
  if (/CrOS/.test(ua)) return "ChromeOS";
  if (/Macintosh|Mac OS X/.test(ua)) return "macOS";
  if (/Linux|X11/.test(ua)) return "Linux";
  return null;
}

function appOf(ua: string): string {
  // Discord's own desktop app is Electron with "discord/1.0.9268" in its agent.
  if (/\bdiscord\/[\d.]+/i.test(ua) && /Electron\//.test(ua)) return "Discord desktop app";
  if (/\bvesktop\//i.test(ua)) return "Vesktop";
  if (/\b(legcord|armcord)\//i.test(ua)) return "Legcord";
  if (/Electron\//.test(ua)) return "Desktop app";
  // Discord's phone apps show it in the system's web view: on iOS one with no
  // "Safari" in its agent, on Android one marked "wv".
  if (/iPhone|iPad/.test(ua) && !/Safari\//.test(ua)) return "Discord app";
  if (/Android/.test(ua) && /;\s*wv\)/.test(ua)) return "Discord app";
  // Discord in a browser.
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Firefox\//.test(ua)) return "Firefox";
  if (/Chrome\//.test(ua)) return "Chrome";
  if (/Safari\//.test(ua)) return "Safari";
  return "Unknown client";
}

/** A client by name: "Discord desktop app · Windows", "Discord app · iPhone", "Firefox · Linux". */
export function clientName(ua: unknown): string {
  if (typeof ua !== "string" || !ua) return "Unknown client";
  const system = systemOf(ua);
  return system ? `${appOf(ua)} · ${system}` : appOf(ua);
}

export interface ClientSpan {
  device: string;
  /** What its player could play (PLAYER_CAPS), or null where it wasn't said. */
  caps: string[] | null;
  av1Encode: boolean;
  from: number;
  to: number;
}

const inOrder = (events: PlayEvent[], userId: string) =>
  events.filter((e) => e.userId === userId).sort((a, b) => a.at - b.at || a.id - b.id);

/** Spans cut to the session: from when the viewer was first seen in it to when they were last. */
function within<T extends { from: number; to: number }>(spans: T[], firstSeen: number, lastSeen: number): T[] {
  return spans.filter((s) => s.to > firstSeen && s.from < lastSeen)
    .map((s) => ({ ...s, from: Math.max(s.from, firstSeen), to: Math.min(s.to, lastSeen) }));
}

/**
 * The clients a viewer watched on, in order, each from when they joined on it
 * to when they moved to the next or were last seen: from their "joined" and
 * "came back" events, which name it and what it plays, and "switched client".
 * `events` may start before the session (PlayDetail.lead): a host is in the
 * room before choosing a title, so what they joined on is there.
 */
export function clientsOf(events: PlayEvent[], userId: string, firstSeen: number, lastSeen: number): ClientSpan[] {
  const out: ClientSpan[] = [];
  for (const e of inOrder(events, userId)) {
    const last = out.at(-1);
    // Gone for a while: the client's time ends there, unless they come back on it.
    if (e.kind === "left") { if (last && last.to === lastSeen) last.to = e.at; continue; }
    const device = e.kind === "switched client" ? e.detail?.to
      : e.kind === "joined" || e.kind === "came back" ? e.detail?.device : null;
    if (typeof device !== "string" || !device) continue;
    const caps = Array.isArray(e.detail?.caps) ? (e.detail?.caps as string[]) : null;
    const av1Encode = e.detail?.av1Encode === true;
    if (last?.device === device) {
      last.to = lastSeen;
      if (caps) Object.assign(last, { caps, av1Encode });
      continue;
    }
    if (last && last.to === lastSeen) last.to = e.at;
    out.push({ device, caps, av1Encode, from: e.at, to: lastSeen });
  }
  return within(out, firstSeen, lastSeen);
}

export type Role = "host" | "co-host" | "viewer";
export interface RoleSpan {
  role: Role;
  from: number;
  to: number;
}

/**
 * A viewer's role over the session: host, co-host or viewer, each from when it
 * began: from what they joined as, and each change of it. Like clientsOf,
 * `events` may start before the session.
 */
export function rolesOf(events: PlayEvent[], userId: string, firstSeen: number, lastSeen: number): RoleSpan[] {
  const out: RoleSpan[] = [];
  const asRole = (v: unknown): Role | null => (v === "host" || v === "co-host" || v === "viewer" ? v : null);
  for (const e of inOrder(events, userId)) {
    const last = out.at(-1);
    if (e.kind === "left") { if (last && last.to === lastSeen) last.to = e.at; continue; }
    const role = e.kind === "role" ? asRole(e.detail?.to)
      : e.kind === "joined" || e.kind === "came back" || e.kind === "switched client" ? asRole(e.detail?.role) : null;
    if (!role) continue;
    if (last && last.to === lastSeen) {
      if (last.role === role) continue;
      last.to = e.at;
    }
    out.push({ role, from: e.at, to: lastSeen });
  }
  // The same role either side of a time away is one stretch of it.
  const merged: RoleSpan[] = [];
  for (const s of within(out, firstSeen, lastSeen)) {
    const prev = merged.at(-1);
    if (prev && prev.role === s.role) prev.to = Math.max(prev.to, s.to);
    else merged.push({ ...s });
  }
  return merged;
}
