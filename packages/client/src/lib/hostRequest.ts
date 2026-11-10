/**
 * Asking an away host for the host role: what this player is told, and how
 * the People tab and the prompts word it. The rules and times are the
 * server's (services/hostRequests); this only shows them.
 */

export type NoRequest = "off" | "host" | "no-host" | "asked" | "declined" | "you-declined" | "protected";

/** The server's "host-request" message, with `offset` added on arrival. */
export interface HostRequestView {
  on: boolean;
  /** The server's clock when it was sent. */
  now: number;
  active: { requesterId: string; requesterName: string | null; endsAt: number } | null;
  /** Null when this player may ask now. */
  blocked: { why: NoRequest; until?: number } | null;
  reclaimUntil: number | null;
  /** Server clock minus this one: endsAt and until are the server's. */
  offset: number;
}

export function fromMessage(msg: Record<string, unknown>, localNow: number): HostRequestView {
  const now = typeof msg.now === "number" ? msg.now : localNow;
  return {
    on: msg.on !== false,
    now,
    active: (msg.active as HostRequestView["active"]) ?? null,
    blocked: (msg.blocked as HostRequestView["blocked"]) ?? null,
    reclaimUntil: typeof msg.reclaimUntil === "number" ? msg.reclaimUntil : null,
    offset: now - localNow,
  };
}

/** Milliseconds to a server time, from this clock. */
export function msUntil(v: HostRequestView, serverTime: number, localNow: number): number {
  return Math.max(0, serverTime - (localNow + v.offset));
}

/** "4:05", "1:02:09". */
export function clock(ms: number): string {
  const s = Math.ceil(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** The People tab's button, for someone who isn't the host. Null: none shown. */
export type RequestButton =
  | { kind: "ask" }
  | { kind: "mine"; leftMs: number }
  | { kind: "theirs"; name: string; leftMs: number }
  | { kind: "wait"; why: "declined" | "you-declined" | "protected"; leftMs: number }
  | { kind: "reclaim"; leftMs: number };

export function requestButton(v: HostRequestView | null, selfId: string | null, localNow: number): RequestButton | null {
  if (!v || !v.on) return null;
  if (v.reclaimUntil !== null && msUntil(v, v.reclaimUntil, localNow) > 0) {
    return { kind: "reclaim", leftMs: msUntil(v, v.reclaimUntil, localNow) };
  }
  const b = v.blocked;
  if (!b) return { kind: "ask" };
  if (b.why === "asked" && v.active) {
    const leftMs = msUntil(v, v.active.endsAt, localNow);
    return v.active.requesterId === selfId
      ? { kind: "mine", leftMs }
      : { kind: "theirs", name: v.active.requesterName || "Someone", leftMs };
  }
  if ((b.why === "declined" || b.why === "you-declined" || b.why === "protected") && b.until !== undefined) {
    const leftMs = msUntil(v, b.until, localNow);
    // Its wait over, it may ask: the server says so with the next roster.
    return leftMs > 0 ? { kind: "wait", why: b.why, leftMs } : { kind: "ask" };
  }
  return null;
}

/** Said when a player who can't ask presses the button. */
export function waitText(why: "declined" | "you-declined" | "protected", leftMs: number): string {
  const t = clock(leftMs);
  if (why === "you-declined") return `The host turned down your request. You can ask again in ${t}.`;
  if (why === "declined") return `The host just turned down a request. Anyone can ask again in ${t}.`;
  return `The host role just changed hands. You can ask for it in ${t}.`;
}

/** The overlay's opener: the People tab's "Requested" button shows the asker's countdown again. */
export const SHOW_REQUEST_EVENT = "pdt-show-host-request";
