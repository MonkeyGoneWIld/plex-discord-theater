/**
 * Plex's Now Playing for the streams ffmpeg makes — and so Tautulli's and
 * Tracearr's, which read it.
 *
 * Plex lists what it is serving. A stream made here from the file is nothing
 * it serves, so it is told, as a player playing the file directly tells it:
 * POST /:/timeline, under PLEX_TOKEN's account as Plex mode's own timelines
 * are, on a player of its own, "Plex Discord Theater". Phase 0 (17 October)
 * saw such a stream in Now Playing within 2 s, as Direct Play, at the file's
 * bitrate — Plex can't know what ffmpeg made of it — and with no Session id,
 * so Tautulli offers no Terminate for it and Plex never says it was ended:
 * it is stopped from the activity.
 *
 * One row a stream: its room, its tracks and quality (a variant), and its
 * title — through the new session every seek starts it on, which reported
 * as a session of its own would be a stop and a new play in Tautulli's
 * history at every seek. Each is reported from the room's clock, so a pop-out
 * or a host gone quiet doesn't stop the reports: every EVERY_MS while it
 * plays, is paused or waits for somebody's picture (buffering), and at once
 * when that changes or it jumps (a seek); "stopped" once it has been gone
 * GONE_MS — longer than a seek's restart takes — so Tautulli writes its row.
 *
 * FFMPEG_REPORT_TO_PLEX=0 says nothing to Plex at all.
 */
import { plexFetch } from "../plex.js";
import { logEvent } from "../logger.js";
import { ffmpegEngineOn } from "./config.js";

export type ReportState = "playing" | "paused" | "buffering";

/** A stream ffmpeg is making for a room, as the room has it now. */
export interface StreamNow {
  /** Its room, variant and title: the same through every seek's new session. */
  key: string;
  sessionId: string;
  ratingKey: string;
  positionS: number;
  state: ReportState;
}

/** How often a stream that hasn't changed is reported. */
const EVERY_MS = 10_000;
/** How often the rooms are looked at, for a change to report at once. */
const LOOK_MS = 1_000;
/** A jump in the position, against where the last report's clock has it, that is reported at once. */
const JUMP_S = 5;
/** Gone this long before Plex hears it stopped: a seek's restart is back sooner. */
const GONE_MS = 15_000;

interface Reported {
  ratingKey: string;
  /** What Plex knows it by, from the first session it was reported on. */
  clientId: string;
  sessionIdentifier: string;
  /** The session it is on now. */
  sessionId: string;
  positionS: number;
  seenAt: number;
  postedAt: number;
  postedState: ReportState | null;
  postedPositionS: number;
  posting: boolean;
}

const reported = new Map<string, Reported>();
let source: (() => StreamNow[]) | null = null;
let durationOf: ((ratingKey: string) => Promise<number | undefined>) | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
/** What has gone wrong already, said once each. */
const said = new Set<string>();

/** FFMPEG_REPORT_TO_PLEX: on unless 0, false, off or no. */
export function reportsToPlex(): boolean {
  if (!ffmpegEngineOn()) return false;
  const v = process.env.FFMPEG_REPORT_TO_PLEX?.trim().toLowerCase();
  return !(v === "0" || v === "false" || v === "off" || v === "no");
}

/**
 * Report what `streams` says is playing. `duration` gives a title's length in
 * ms, which Plex tracks progress against. A test calls plexReportTick itself.
 */
export function reportFrom(
  streams: () => StreamNow[],
  duration: (ratingKey: string) => Promise<number | undefined>,
): void {
  source = streams;
  durationOf = duration;
}

/** reportFrom, looked at every LOOK_MS while the engine is on. */
export function startPlexReports(
  streams: () => StreamNow[],
  duration: (ratingKey: string) => Promise<number | undefined>,
): void {
  reportFrom(streams, duration);
  if (timer || !ffmpegEngineOn()) return;
  timer = setInterval(() => void plexReportTick(), LOOK_MS);
  timer.unref();
}

function sayOnce(cause: string, msg: string, fields: Record<string, unknown>): void {
  if (said.has(cause)) return;
  said.add(cause);
  logEvent("PlexReport", msg, fields);
}

async function post(r: Reported, state: ReportState | "stopped", positionS: number): Promise<void> {
  try {
    const duration = await durationOf?.(r.ratingKey).catch(() => undefined);
    const res = await plexFetch(
      "/:/timeline",
      {
        ratingKey: r.ratingKey,
        key: `/library/metadata/${r.ratingKey}`,
        state,
        time: String(Math.max(0, Math.round(positionS * 1000))),
        duration: duration ? String(duration) : "0",
        identifier: "com.plexapp.plugins.library",
      },
      {
        "X-Plex-Session-Identifier": r.sessionIdentifier,
        "X-Plex-Client-Identifier": r.clientId,
        "X-Plex-Device-Name": "Discord Theater",
        "X-Plex-Platform": "Chrome",
        "X-Plex-Device": "Browser",
      },
      "POST",
    );
    const body = await res.text().catch(() => "");
    if (!res.ok) {
      sayOnce(`status ${res.status}`, "Plex refused a timeline report; streams may not show in Now Playing", {
        status: res.status, body: body.slice(0, 160) || "none",
      });
    } else if (/terminationCode|terminationText/.test(body)) {
      // Never seen in Phase 0, where Tautulli had nothing to terminate with.
      sayOnce(`terminated ${r.clientId}`, "Plex says a stream was ended there; it plays on until stopped from the activity", {
        client: r.clientId, ratingKey: r.ratingKey, body: body.slice(0, 200),
      });
    }
  } catch (err) {
    sayOnce("unreachable", "couldn't tell Plex what is playing", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Look at what is playing and tell Plex what has changed — every LOOK_MS; exported for the tests. */
export async function plexReportTick(now = Date.now()): Promise<void> {
  if (!source || !reportsToPlex()) return;
  const posts: Promise<void>[] = [];
  let streams: StreamNow[];
  try {
    streams = source();
  } catch {
    return;
  }
  for (const s of streams) {
    let r = reported.get(s.key);
    if (!r) {
      r = {
        ratingKey: s.ratingKey,
        clientId: `plex-discord-theater-${s.sessionId}`,
        sessionIdentifier: s.sessionId,
        sessionId: s.sessionId,
        positionS: s.positionS,
        seenAt: now,
        postedAt: 0,
        postedState: null,
        postedPositionS: 0,
        posting: false,
      };
      reported.set(s.key, r);
      logEvent("PlexReport", "showing a stream in Plex's Now Playing", {
        session: s.sessionId.substring(0, 8), ratingKey: s.ratingKey, client: r.clientId,
      });
    }
    r.sessionId = s.sessionId;
    r.positionS = s.positionS;
    r.seenAt = now;
    if (r.posting) continue;
    const clockS = r.postedState === "playing" ? r.postedPositionS + (now - r.postedAt) / 1000 : r.postedPositionS;
    const due = r.postedState !== s.state || Math.abs(s.positionS - clockS) > JUMP_S || now - r.postedAt >= EVERY_MS;
    if (!due) continue;
    r.posting = true;
    r.postedAt = now;
    r.postedState = s.state;
    r.postedPositionS = s.positionS;
    const it = r;
    posts.push(post(it, s.state, s.positionS).finally(() => { it.posting = false; }));
  }
  for (const [key, r] of reported) {
    if (now - r.seenAt < GONE_MS) continue;
    reported.delete(key);
    logEvent("PlexReport", "telling Plex a stream stopped", {
      session: r.sessionId.substring(0, 8), ratingKey: r.ratingKey, client: r.clientId, atS: Math.round(r.positionS),
    });
    posts.push(post(r, "stopped", r.positionS));
  }
  await Promise.all(posts);
}

/**
 * The player a stream (StreamNow.key) is reported to Plex as: its
 * Player@machineIdentifier in /status/sessions, the same through every seek.
 * Null before its first report, and with FFMPEG_REPORT_TO_PLEX off. For the
 * upload budget (routes/qbt-manager.ts), which takes that row of Plex's as
 * the Theater's own rather than counting the stream twice.
 */
export function plexClientIdOf(key: string): string | null {
  if (!reportsToPlex()) return null;
  return reported.get(key)?.clientId ?? null;
}

/** Tell Plex everything reported has stopped: the server is going down. */
export async function reportAllStopped(): Promise<void> {
  if (!reportsToPlex()) return;
  const all = [...reported.values()];
  reported.clear();
  await Promise.all(all.map((r) => post(r, "stopped", r.positionS)));
}
