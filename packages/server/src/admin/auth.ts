import crypto from "node:crypto";
import type { NextFunction, Request, Response } from "express";

/**
 * Signing in to the dashboard: one password (ADMIN_PASSWORD), and a session
 * cookie for whoever gives it.
 *
 * A session is a token the server signed with a key made from the password,
 * so it holds across restarts and never runs out: the dashboard is on the
 * owner's own network, and asking for the password again is all a time
 * limit ever did. Signing out ends it here; changing ADMIN_PASSWORD ends
 * every session there is.
 *
 * Until 17 November sessions were kept in memory for 12 hours, so every
 * restart, and every evening, asked for the password again. And the cookie
 * had one name for every port: two bots' dashboards on one machine (on
 * 3060 and 3050, say) took turns replacing each other's, since a browser
 * keeps cookies by host and not by port. The cookie is now named for the
 * port the page was opened on.
 */
const COOKIE = "pdt_admin";
/** As long as a browser keeps a cookie (400 days), and renewed as the page is opened. */
export const COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;
const MAX_REVOKED = 10_000;

/** Whether `given` is the password, in time that doesn't depend on either. */
export function passwordMatches(given: unknown, expected: string): boolean {
  if (typeof given !== "string" || !expected) return false;
  const a = crypto.createHash("sha256").update(given).digest();
  const b = crypto.createHash("sha256").update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

export class AdminSessions {
  private readonly key: Buffer;
  /** Signed out, this run. */
  private readonly revoked = new Set<string>();

  constructor(password: string) {
    this.key = crypto.createHash("sha256").update(`pdt-admin-session\0${password}`).digest();
  }

  private sign(nonce: string): string {
    return crypto.createHmac("sha256", this.key).update(nonce).digest("hex").slice(0, 32);
  }

  /** 64 hex digits: 32 at random and 32 that say this server gave them. */
  create(): string {
    const nonce = crypto.randomBytes(16).toString("hex");
    return nonce + this.sign(nonce);
  }

  valid(token: string | null): boolean {
    if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
    const nonce = token.slice(0, 32);
    const given = Buffer.from(token.slice(32), "hex");
    const right = Buffer.from(this.sign(nonce), "hex");
    return crypto.timingSafeEqual(given, right) && !this.revoked.has(nonce);
  }

  revoke(token: string | null): void {
    if (!this.valid(token)) return;
    if (this.revoked.size >= MAX_REVOKED) this.revoked.delete(this.revoked.values().next().value!);
    this.revoked.add(token!.slice(0, 32));
  }
}

/** The cookie's name where the page was opened: `pdt_admin_3060`. */
export function cookieName(req: Pick<Request, "headers">): string {
  const host = String(req.headers.host ?? "");
  const port = /:(\d{1,5})$/.exec(host)?.[1];
  const https = (req as Partial<Request>).secure || req.headers["x-forwarded-proto"] === "https";
  return `${COOKIE}_${port ?? (https ? "443" : "80")}`;
}

/** The session cookie's value, from the Cookie header. */
export function cookieToken(req: Pick<Request, "headers">): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  const name = cookieName(req);
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) {
      const value = part.slice(eq + 1).trim();
      return /^[0-9a-f]{64}$/.test(value) ? value : null;
    }
  }
  return null;
}

/** The Set-Cookie for a session, or for clearing it. */
export function sessionCookie(req: Request, token: string | null): string {
  // Secure only over HTTPS, as the page is usually opened over the LAN by
  // address, where a Secure cookie would never be sent back.
  const secure = req.secure || req.headers["x-forwarded-proto"] === "https" ? "; Secure" : "";
  const name = cookieName(req);
  return token
    ? `${name}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(COOKIE_MAX_AGE_MS / 1000)}${secure}`
    : `${name}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
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
