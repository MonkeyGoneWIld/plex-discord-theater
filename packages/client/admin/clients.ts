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
  from: number;
  to: number;
}

/**
 * The clients a viewer watched on, in order, each from when they joined on it
 * to when they moved to the next or were last seen: from their "joined" and
 * "came back" events, which name it, and "switched client".
 */
export function clientsOf(events: PlayEvent[], userId: string, lastSeen: number): ClientSpan[] {
  const out: ClientSpan[] = [];
  const mine = events.filter((e) => e.userId === userId).sort((a, b) => a.at - b.at || a.id - b.id);
  for (const e of mine) {
    const last = out.at(-1);
    // Gone for a while: the client's time ends there, unless they come back on it.
    if (e.kind === "left") { if (last) last.to = e.at; continue; }
    const device = e.kind === "switched client" ? e.detail?.to
      : e.kind === "joined" || e.kind === "came back" ? e.detail?.device : null;
    if (typeof device !== "string" || !device) continue;
    if (last?.device === device) { last.to = lastSeen; continue; }
    if (last && last.to === lastSeen) last.to = e.at;
    out.push({ device, from: e.at, to: lastSeen });
  }
  return out;
}
