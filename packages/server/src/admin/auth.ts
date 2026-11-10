import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Signing in to the admin page: one password (ADMIN_PASSWORD), and a session
 * cookie for whoever gives it. Sessions live in memory, so a restart signs
 * everybody out, which for one admin is no loss.
 */
export const COOKIE = "pdt_admin";
export const SESSION_MS = 12 * 60 * 60 * 1000;

/** Whether `given` is the password, in time that doesn't depend on either. */
export function passwordMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || !expected) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export class AdminSessions {
  private readonly expiry = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now, private readonly ttlMs = SESSION_MS) {}

  create(): string {
    this.prune();
    const token = crypto.randomBytes(32).toString("hex");
    this.expiry.set(token, this.now() + this.ttlMs);
    return token;
  }

  valid(token: string | null): boolean {
    if (!token) return false;
    const until = this.expiry.get(token);
    if (until === undefined) return false;
    if (until <= this.now()) {
      this.expiry.delete(token);
      return false;
    }
    return true;
  }

  revoke(token: string | null): void {
    if (token) this.expiry.delete(token);
  }

  get size(): number {
    this.prune();
    return this.expiry.size;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, until] of this.expiry) if (until <= now) this.expiry.delete(token);
  }
}

/** The session cookie's value, from the Cookie header. */
export function cookieToken(req: Request): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === COOKIE) {
      const value = part.slice(eq + 1).trim();
      return /^[0-9a-f]{64}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** The Set-Cookie for a session, or for clearing it. */
export function sessionCookie(req: Request, token: string | null, maxAgeMs = SESSION_MS): string {
  // Secure only over HTTPS, as the page is usually opened over the LAN by
  // address, where a Secure cookie would never be sent back.
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  return token
    ? `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`
    : `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
}

export function requireAdmin(sessions: AdminSessions) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (sessions.valid(cookieToken(req))) {
      next();
      return;
    }
    res.status(401).json({ error: "Sign in first" });
  };
}
