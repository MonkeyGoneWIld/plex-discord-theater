import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { adminRooms, getQbtManagerStreams, type AdminRoom } from "../services/sync.js";
import { instanceHosts } from "../routes/discord.js";
import { streamNotesOf } from "../services/stream-notes.js";
import { isFfmpegSession, ffmpegSessionKnown } from "../services/ffmpeg/engine.js";
import { LOG_DIR } from "../services/logger.js";

const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);

// ─── Now playing ─────────────────────────────────────────────────

/** One stream (a room's variant) as the admin page shows it. */
export interface StreamView {
  variantKey: string;
  hlsSessionId: string | null;
  audioStreamId: number;
  subtitleStreamId: number;
  quality: number;
  ownerUserId: string | null;
  sessionOffset: number;
  idleS: number | null;
  /** Watching it now: user ids. */
  viewers: string[];
  isHostStream: boolean;
  engine: "ffmpeg" | "plex" | null;
  decision: "copy" | "transcode" | null;
  /** Why it is re-encoded, as the player's Stats for nerds says it. */
  reason: string | null;
  /** The one line: "Direct play", "Transcode: …". */
  summary: string;
  /** What one viewer of it downloads. */
  kbps: number | null;
  kbpsSource: string | null;
  plexTranscodeKey: string | null;
  plexClientId: string | null;
  /** Everything the playlist told its players (services/stream-notes.ts). */
  notes: Record<string, string | number>;
  notesAt: number | null;
}

/** A viewer's play so far, as the recorder (admin/recorder.ts) has counted it. */
export interface ViewerData {
  /** Seconds they watched while the room played. */
  watchedS: number;
  /** Over HTTP: from the bot, through Discord's proxy. */
  httpBytes: number;
  /** From other viewers' players. */
  p2pBytes: number;
  /** Of the HTTP, what Discord's proxy answered with a cache status… */
  edgeBytes: number;
  /** …and what its cache had already, so the bot didn't send it. */
  edgeHitBytes: number;
  /** HTTP less what Discord's cache handed over. */
  botBytes: number;
  /** Times the picture stopped for want of data, not counting seeks. */
  stalls: number;
  stalledMs: number;
  errors: number;
}

export type ClientView = AdminRoom["clients"][number] & { data?: ViewerData };

export interface RoomView extends Omit<AdminRoom, "variants" | "clients"> {
  clients: ClientView[];
  discord: { guildId: string | null; channelId: string | null; hostUserId: string | null; startedAt: number | null };
  streams: StreamView[];
  /** Its play in the history, while the admin page records. */
  playId?: number | null;
  /** The names of people it mentions who aren't in it now: its host, who a stream is kept for. */
  names?: Record<string, string>;
  /** Its delivery over the last minutes, by source (admin/recorder.ts flowSeries). */
  flow?: { stepS: number; windowS: number; points: Array<[number, number, number, number]> } | null;
}

export interface Overview {
  at: number;
  totals: {
    rooms: number;
    /** Distinct people connected, in any room. */
    people: number;
    watching: number;
    streams: number;
    copied: number;
    reencoded: number;
    /** The bitrates of the streams somebody watches, one feed each. */
    feedKbps: number;
  };
  rooms: RoomView[];
}

/** "Direct play", "Direct stream: audio converted", "Transcode: <why>", from a stream's notes: the words Stats for nerds uses. */
export function summaryOf(notes: Record<string, string | number>): string {
  const audio = notes.audio === "transcode"
    ? `; audio converted${notes.audioReason ? ` (${notes.audioReason})` : ""}`
    : "";
  if (notes.video === "copy") return audio ? `Direct stream${audio.replace("; ", ": ")}` : "Direct play";
  if (notes.video === "transcode") return `Transcode: ${notes.reason ?? "no reason reported"}${audio}`;
  return "Starting: details pending";
}

export function overview(now = Date.now()): Overview {
  const facts = new Map(getQbtManagerStreams().map((s) => [s.hls_session_id, s] as const));
  const rooms: RoomView[] = adminRooms(now).map(({ variants, ...room }) => {
    const instance = instanceHosts.get(room.id);
    const streams: StreamView[] = variants.map((v) => {
      const kept = v.hlsSessionId ? streamNotesOf(v.hlsSessionId) : null;
      const notes = kept?.values ?? {};
      const fact = v.hlsSessionId ? facts.get(v.hlsSessionId) : undefined;
      const engine = !v.hlsSessionId ? null
        : notes.engine === "ffmpeg" || ffmpegSessionKnown(v.hlsSessionId) || isFfmpegSession(v.hlsSessionId) ? "ffmpeg"
        : "plex";
      const decision = notes.video === "copy" || notes.video === "transcode" ? notes.video : null;
      const noted = typeof notes.kbps === "number" ? notes.kbps : Number(notes.kbps) || null;
      const measured = fact?.bandwidth_source === "measured" ? fact.bandwidth_kbps ?? null : null;
      return {
        variantKey: v.key,
        hlsSessionId: v.hlsSessionId,
        audioStreamId: v.audioStreamId,
        subtitleStreamId: v.subtitleStreamId,
        quality: v.quality,
        ownerUserId: v.ownerUserId,
        sessionOffset: v.sessionOffset,
        idleS: v.idleS,
        viewers: room.clients.filter((c) => c.connected && c.watching && c.variantKey === v.key).map((c) => c.userId),
        isHostStream: room.hostVariantKey === v.key,
        engine,
        decision,
        reason: decision === "transcode" ? String(notes.reason ?? "") || null : null,
        summary: summaryOf(notes),
        // Measured when it has been; else what its playlist says. The figure
        // the qBittorrent manager is given before then is the server's
        // target bitrate, which read as 20 Mbps for a 4.6 Mbps film.
        kbps: measured ?? noted ?? fact?.bandwidth_kbps ?? null,
        kbpsSource: measured ? "measured" : noted ? "playlist" : fact?.bandwidth_kbps ? "target" : null,
        plexTranscodeKey: fact?.plex_transcode_key ?? null,
        plexClientId: fact?.plex_client_id ?? null,
        notes,
        notesAt: kept?.at ?? null,
      };
    });
    return {
      ...room,
      discord: {
        guildId: instance?.guildId ?? room.heldFor?.guildId ?? null,
        channelId: instance?.channelId ?? room.heldFor?.channelId ?? null,
        hostUserId: instance?.hostUserId ?? room.heldFor?.hostUserId ?? null,
        startedAt: instance?.createdAt ?? null,
      },
      streams,
    };
  });
  const connected = rooms.flatMap((r) => r.clients.filter((c) => c.connected));
  const live = rooms.flatMap((r) => r.streams.filter((s) => s.hlsSessionId));
  return {
    at: now,
    totals: {
      rooms: rooms.length,
      people: new Set(connected.map((c) => c.userId)).size,
      watching: connected.filter((c) => c.watching).length,
      streams: live.length,
      copied: live.filter((s) => s.decision === "copy").length,
      reencoded: live.filter((s) => s.decision === "transcode").length,
      feedKbps: live.filter((s) => s.viewers.length > 0).reduce((sum, s) => sum + (s.kbps ?? 0), 0),
    },
    rooms,
  };
}

// ─── Settings ────────────────────────────────────────────────────

const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS|PIN|COOKIE|CREDENTIALS?)(?:_\d+)?$/;

/** A value as the page may show it: secrets as whether they are set, credentials out of URLs. */
export function shownValue(name: string, value: string | undefined): { set: boolean; value: string | null; secret: boolean } {
  const secret = SECRET_NAME.test(name);
  if (value === undefined || value === "") return { set: false, value: null, secret };
  if (secret) return { set: true, value: `set · ${value.length} characters`, secret };
  const clean = value
    .replace(/\/\/[^/@\s]+@/g, "//<redacted>@")
    .replace(/([?&](?:X-Plex-Token|token|key|apikey|api_key)=)[^&\s]+/gi, "$1<redacted>");
  return { set: true, value: clean, secret };
}

let settingNames: string[] | null = null;

/**
 * Every setting the server reads, found in its own code: process.env.NAME,
 * process.env["NAME"] and numberSetting / sizeSetting("NAME"). So the list is
 * never behind the code, and shows the settings left unset too.
 */
export function readSettingNames(root = path.resolve(here, "..")): string[] {
  const names = new Set<string>();
  const patterns = [
    /process\.env\.([A-Z][A-Z0-9_]*)/g,
    /process\.env\[\s*["'`]([A-Z][A-Z0-9_]*)["'`]\s*\]/g,
    /(?:numberSetting|sizeSetting)\(\s*["'`]([A-Z][A-Z0-9_]*)["'`]/g,
  ];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(?:ts|js)$/.test(entry.name) && !entry.name.endsWith(".d.ts")) {
        const text = fs.readFileSync(full, "utf8");
        for (const re of patterns) for (const m of text.matchAll(re)) names.add(m[1]);
      }
    }
  };
  walk(root);
  return [...names].sort();
}

export interface SettingsView {
  settings: Array<{ name: string; set: boolean; value: string | null; secret: boolean }>;
  system: Record<string, string | number | null>;
}

export function settingsView(now = Date.now()): SettingsView {
  settingNames ??= readSettingNames();
  let version: string | null = null;
  for (const file of [path.resolve(here, "../../../../package.json"), path.resolve(here, "../../package.json")]) {
    try {
      version = (JSON.parse(fs.readFileSync(file, "utf8")) as { version?: string }).version ?? null;
      if (version) break;
    } catch { /* not there */ }
  }
  const memory = process.memoryUsage();
  return {
    settings: settingNames.map((name) => ({ name, ...shownValue(name, process.env[name]) })),
    system: {
      version,
      node: process.version,
      platform: `${process.platform} ${process.arch}`,
      pid: process.pid,
      startedAt: new Date(now - process.uptime() * 1000).toISOString(),
      uptimeS: Math.round(process.uptime()),
      rssMB: Math.round(memory.rss / 1e6),
      heapUsedMB: Math.round(memory.heapUsed / 1e6),
      logDir: LOG_DIR,
    },
  };
}

// ─── Logs ────────────────────────────────────────────────────────

export const LOG_NAME = /^theater-\d{4}-\d{2}-\d{2}(?:-\d+)?\.log$/;

export interface LogFile { name: string; bytes: number; modified: string }

export function logFiles(dir = LOG_DIR): LogFile[] {
  let names: string[];
  try {
    names = fs.readdirSync(dir).filter((n) => LOG_NAME.test(n));
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const stat = fs.statSync(path.join(dir, name));
      return { name, bytes: stat.size, modified: stat.mtime.toISOString() };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified) || b.name.localeCompare(a.name));
}

export interface LogLine {
  n: number;
  at: string | null;
  level: "error" | "warn" | "info";
  tag: string | null;
  /** A player's line (routes/logs.ts): which player sent it. */
  client: string | null;
  text: string;
}

const LINE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z) (?:\[(FATAL|ERROR|WARN|DEBUG)\] )?(?:\[([^\]\s][^\]]{0,60})\] )?(.*)$/;

const TAG = /^\[([^\]\s][^\]]{0,60})\] (.*)$/;

export function parseLogLine(raw: string, n: number): LogLine {
  const m = LINE.exec(raw);
  if (!m) return { n, at: null, level: "info", tag: null, client: null, text: raw };
  const level = m[2] === "FATAL" || m[2] === "ERROR" ? "error" : m[2] === "WARN" ? "warn" : "info";
  // A player's line is "[client:<id>] [Tag] text": the tag is its own.
  const inner = m[3]?.startsWith("client:") ? TAG.exec(m[4]) : null;
  if (inner) return { n, at: m[1], level, tag: inner[1], client: m[3].slice(7), text: inner[2] };
  return { n, at: m[1], level, tag: m[3] ?? null, client: m[3]?.startsWith("client:") ? m[3].slice(7) : null, text: m[4] };
}

/** The logger already takes secrets out (services/logger.ts, redact); this is a second net. */
function scrub(line: string): string {
  return line
    .replace(/([?&](?:X-Plex-Token|token|key)=)[^&\s"]+/gi, "$1<redacted>")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1<redacted>");
}

export interface LogQuery { q?: string; level?: "warn" | "error"; tag?: string; limit?: number }

/** The last `limit` lines of a log file that match, oldest first. */
export async function readLog(name: string, query: LogQuery = {}, dir = LOG_DIR): Promise<{ lines: LogLine[]; scanned: number; matched: number } | null> {
  if (!LOG_NAME.test(name)) return null;
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return null;
  const limit = Math.min(5000, Math.max(1, query.limit ?? 500));
  const needle = query.q?.trim().toLowerCase() || null;
  const tag = query.tag?.trim().toLowerCase() || null;
  const kept: LogLine[] = [];
  let scanned = 0;
  let matched = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  for await (const raw of lines) {
    scanned++;
    const line = parseLogLine(scrub(raw), scanned);
    if (query.level === "error" && line.level !== "error") continue;
    if (query.level === "warn" && line.level === "info") continue;
    if (tag && line.tag?.toLowerCase() !== tag) continue;
    if (needle && !raw.toLowerCase().includes(needle)) continue;
    matched++;
    kept.push(line);
    if (kept.length > limit) kept.shift();
  }
  return { lines: kept, scanned, matched };
}
