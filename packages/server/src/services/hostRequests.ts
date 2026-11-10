/**
 * Asking an away host for the host role.
 *
 * A host who leaves is replaced at once (sync.ts). One who stays but stops
 * answering — paused and gone to make dinner — left everyone else unable to
 * play, skip or choose anything until they came back. So anyone else may ask
 * for the role: the host is shown who asked and a countdown, and if they don't
 * answer before it ends, the role passes to whoever asked.
 *
 * Kept from being a way to take the room from a host who is there:
 *  - One request at a time; everyone else sees who asked and the time left.
 *  - The host declining, or using the controls while it counts down (they are
 *    there), shuts requests for everyone for DECLINED_ROOM_MS and for the one
 *    who asked for DECLINED_USER_MS.
 *  - The role passed on, nobody may ask the new host for PROTECTED_MS; and a
 *    host it was taken from by the countdown may take it back within
 *    RECLAIM_MS, since they are the reason it moved.
 * A host the activity sees away (lib/away on their client: hidden, or nothing
 * touched while paused) has WAIT_AWAY_MS rather than WAIT_MS, and a countdown
 * longer than that drops to it when they go away. Discord's own idle status
 * isn't something an activity can read.
 *
 * Everything is the room's: a new activity — after everyone left, or in
 * another channel — starts with none of it. The times are the server's.
 * HOST_REQUESTS=off turns it all off.
 */

/** The PDT_ variables are for the tests. */
export const WAIT_MS = Number(process.env.PDT_HOST_REQUEST_WAIT_MS) || 5 * 60_000;
export const WAIT_AWAY_MS = Number(process.env.PDT_HOST_REQUEST_AWAY_MS) || 60_000;
export const DECLINED_ROOM_MS = 15 * 60_000;
export const DECLINED_USER_MS = 2 * 60 * 60_000;
export const PROTECTED_MS = 15 * 60_000;
export const RECLAIM_MS = 10 * 60_000;

export function hostRequestsOn(): boolean {
  return !/^(off|0|false|no)$/i.test((process.env.HOST_REQUESTS ?? "").trim());
}

export interface ActiveRequest {
  requesterId: string;
  requesterName: string | null;
  /** The host asked: a request ends if the role moves another way. */
  hostId: string;
  endsAt: number;
}

export interface HostRequests {
  active: ActiveRequest | null;
  /** Nobody may ask until then: the host declined. */
  roomBlockedUntil: number;
  /** Each who asked and was declined, until when they may ask again. */
  userBlockedUntil: Map<string, number>;
  /** The role just passed on: nobody may ask until then. */
  protectedUntil: number;
  /** A host the countdown took the role from, and until when they may take it back. */
  reclaim: { userId: string; until: number } | null;
}

export function newHostRequests(): HostRequests {
  return { active: null, roomBlockedUntil: 0, userBlockedUntil: new Map(), protectedUntil: 0, reclaim: null };
}

/** Why someone can't ask now. */
export type NoRequest = "off" | "host" | "no-host" | "asked" | "declined" | "you-declined" | "protected";

export function whyNot(
  s: HostRequests, userId: string, o: { isHost: boolean; hasHost: boolean; now: number },
): { why: NoRequest; until?: number } | null {
  if (!hostRequestsOn()) return { why: "off" };
  if (o.isHost) return { why: "host" };
  if (!o.hasHost) return { why: "no-host" };
  if (s.active) return { why: "asked", until: s.active.endsAt };
  const mine = s.userBlockedUntil.get(userId) ?? 0;
  if (mine > o.now) return { why: "you-declined", until: mine };
  if (s.roomBlockedUntil > o.now) return { why: "declined", until: s.roomBlockedUntil };
  if (s.protectedUntil > o.now) return { why: "protected", until: s.protectedUntil };
  return null;
}

export function startRequest(
  s: HostRequests, requester: { id: string; name: string | null }, hostId: string, hostAway: boolean, now: number,
): ActiveRequest {
  s.active = {
    requesterId: requester.id, requesterName: requester.name, hostId,
    endsAt: now + (hostAway ? WAIT_AWAY_MS : WAIT_MS),
  };
  return s.active;
}

/** The host gone away: a countdown longer than WAIT_AWAY_MS drops to it. True when it changed. */
export function hostWentAway(s: HostRequests, now: number): boolean {
  if (!s.active || s.active.endsAt - now <= WAIT_AWAY_MS) return false;
  s.active.endsAt = now + WAIT_AWAY_MS;
  return true;
}

/** The host said no, or used the controls while it counted down. */
export function declineRequest(s: HostRequests, now: number): ActiveRequest | null {
  const a = s.active;
  if (!a) return null;
  s.active = null;
  s.roomBlockedUntil = now + DECLINED_ROOM_MS;
  s.userBlockedUntil.set(a.requesterId, now + DECLINED_USER_MS);
  return a;
}

/** Ended without an answer either way: who asked left, or the role moved another way. */
export function dropRequest(s: HostRequests): ActiveRequest | null {
  const a = s.active;
  s.active = null;
  return a;
}

/** The role passed on: by the host's yes, or by the countdown (`fromHostId` may take it back). */
export function handedOver(s: HostRequests, now: number, fromHostId: string | null): void {
  s.active = null;
  s.protectedUntil = now + PROTECTED_MS;
  s.reclaim = fromHostId ? { userId: fromHostId, until: now + RECLAIM_MS } : null;
}

/** Whether `userId` may take the role back now. */
export function mayReclaim(s: HostRequests, userId: string, now: number): boolean {
  return !!s.reclaim && s.reclaim.userId === userId && now < s.reclaim.until;
}

/** What one player is told: for its People tab, the host's prompt and the asker's countdown. */
export interface HostRequestView {
  type: "host-request";
  on: boolean;
  /** The server's clock, for the countdowns. */
  now: number;
  active: { requesterId: string; requesterName: string | null; endsAt: number } | null;
  /** Null when this player may ask now. */
  blocked: { why: NoRequest; until?: number } | null;
  reclaimUntil: number | null;
}

export function viewFor(
  s: HostRequests, userId: string, o: { isHost: boolean; hasHost: boolean; now: number },
): HostRequestView {
  const a = s.active;
  return {
    type: "host-request",
    on: hostRequestsOn(),
    now: o.now,
    active: a ? { requesterId: a.requesterId, requesterName: a.requesterName, endsAt: a.endsAt } : null,
    blocked: whyNot(s, userId, o),
    reclaimUntil: !o.isHost && mayReclaim(s, userId, o.now) ? s.reclaim!.until : null,
  };
}
