/**
 * An update from main to this branch, as far as the databases go.
 *
 * 18 November: the update has to open every file main and the first Theater
 * Dashboard left behind, add what is new, and read what was there. Main's
 * schema code is the same as this branch's for the sessions, instances, Plex
 * accounts, watch history, detail cache and thumbnail cache; the subtitle
 * cache gains a `whole` column and reads rows of main's parser version again
 * from their kept text; and admin.sqlite is new on this branch, or, where a
 * first dashboard ran, has the seven tables of its first recorder (f7294a8,
 * 10 November) with none of the eight tables or two columns added since.
 *
 * Each module opens its file when it is imported, so each set of files is
 * opened in a process of its own (this file, run as "open <dir>").
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import Database from "better-sqlite3";

const DAY = 86_400_000;

if (process.argv[2] === "open") {
  const dir = process.argv[3];
  process.env.THUMB_CACHE_DIR = dir;
  process.env.PLEX_URL ??= "http://127.0.0.1:9";
  process.env.PLEX_TOKEN ??= "x";
  for (const m of ["../src/middleware/auth.ts", "../src/routes/discord.ts", "../src/services/plex-accounts.ts",
    "../src/services/watch-history.ts", "../src/services/detail-cache.ts", "../src/services/thumb-cache.ts"]) await import(m);
  const subs = await import("../src/services/embedded-subtitles.ts");
  const { Recorder } = await import("../src/admin/recorder.ts");
  const now = Date.now();
  const rec = new Recorder({
    dbPath: path.join(dir, "admin.sqlite"), now: () => now, instances: () => new Map(),
    source: (at: number) => ({ at, totals: {}, rooms: [] }) as never,
    system: () => ({ cpuPct: 12, botCpuPct: 3, memPct: 40, rssMb: 200, load1: 0.5 }),
  });
  const history = rec.history();
  const play = history[0] ? rec.play(history[0].id) : null;
  rec.processing({ at: now, kind: "probe", ms: 120, ok: true, detail: { streams: 3 } });
  rec.tick(now);
  const graphs = rec.graphs({ days: 30 }, now);
  const load = rec.systemLoad({ hours: 1 }, now + 60_000);
  const result = {
    plays: history.length,
    title: history[0]?.title ?? null,
    viewers: play?.viewers.length ?? null,
    events: play?.events.map((e) => e.kind) ?? null,
    person: rec.person("u1") ? "found" : "missing",
    requests: rec.requests().length,
    usage: rec.usage().length,
    sessionsInGraphs: graphs.totals.plays,
    processing: graphs.processing.map((p) => [p.kind, p.count]),
    loadPoints: load.points.filter((p) => p.cpuPct !== null).length,
    subtitleOfMain: subs.embeddedSubtitleState("s-main", "fp-1"),
    subtitleOfMainText: subs.embeddedSubtitleText("s-main", "fp-1"),
    subtitleOfMainKeptAt: subs.embeddedSubtitleKeptAt("s-main"),
    subtitleWithoutText: subs.embeddedSubtitleState("s-old", null),
  };
  rec.close("check done");
  const schema: Record<string, Record<string, string[]>> = {};
  for (const f of fs.readdirSync(dir).filter((f) => f.endsWith(".sqlite")).sort()) {
    const db = new Database(path.join(dir, f), { readonly: true });
    const rows = db.prepare("SELECT name, type FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{ name: string; type: string }>;
    schema[f] = {};
    for (const r of rows) {
      schema[f][`${r.type} ${r.name}`] = r.type === "table"
        ? (db.prepare(`PRAGMA table_info(${r.name})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: unknown }>)
          .map((c) => `${c.name} ${c.type}${c.notnull ? " not null" : ""}${c.dflt_value !== null ? ` default ${c.dflt_value}` : ""}`).sort()
        : (db.prepare(`PRAGMA index_info(${r.name})`).all() as Array<{ name: string }>).map((c) => c.name);
    }
    schema[f].user_version = [String(db.pragma("user_version", { simple: true }))];
    db.close();
  }
  console.log(`RESULT ${JSON.stringify({ result, schema })}`);
  process.exit(0);
}

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; console.log(`  ok   ${name}`); return; }
  fail++;
  console.log(`  FAIL ${name}\n         expected ${JSON.stringify(expected)}\n         actual   ${JSON.stringify(actual)}`);
}

/** The first recorder's tables (f7294a8), as it made them. */
const FIRST_RECORDER = `
CREATE TABLE IF NOT EXISTS plays (id INTEGER PRIMARY KEY, room_id TEXT NOT NULL, rating_key TEXT NOT NULL, title TEXT, guild_id TEXT,
  channel_id TEXT, host_user_id TEXT, started_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, ended_at INTEGER, end_reason TEXT,
  end_by TEXT, start_pos_s REAL, last_pos_s REAL, played_s REAL NOT NULL DEFAULT 0, peak_viewers INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS plays_started ON plays(started_at);
CREATE TABLE IF NOT EXISTS play_viewers (play_id INTEGER NOT NULL, user_id TEXT NOT NULL, username TEXT, role TEXT,
  first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL, watched_s REAL NOT NULL DEFAULT 0, http_bytes INTEGER NOT NULL DEFAULT 0,
  p2p_bytes INTEGER NOT NULL DEFAULT 0, edge_bytes INTEGER NOT NULL DEFAULT 0, edge_hit_bytes INTEGER NOT NULL DEFAULT 0,
  stalls INTEGER NOT NULL DEFAULT 0, stalled_ms INTEGER NOT NULL DEFAULT 0, errors INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (play_id, user_id));
CREATE INDEX IF NOT EXISTS play_viewers_user ON play_viewers(user_id);
CREATE TABLE IF NOT EXISTS play_streams (id INTEGER PRIMARY KEY, play_id INTEGER NOT NULL, hls_session_id TEXT NOT NULL, variant_key TEXT,
  engine TEXT, decision TEXT, reason TEXT, summary TEXT, audio_stream_id INTEGER, subtitle_stream_id INTEGER, quality INTEGER,
  owner_user_id TEXT, offset_s REAL, kbps INTEGER, notes TEXT, started_at INTEGER NOT NULL, ended_at INTEGER,
  peak_viewers INTEGER NOT NULL DEFAULT 0, UNIQUE (play_id, hls_session_id));
CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, play_id INTEGER, room_id TEXT, at INTEGER NOT NULL, kind TEXT NOT NULL,
  user_id TEXT, username TEXT, pos_s REAL, detail TEXT);
CREATE INDEX IF NOT EXISTS events_play ON events(play_id, at);
CREATE TABLE IF NOT EXISTS usage (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, kind TEXT NOT NULL, room_id TEXT, user_id TEXT,
  username TEXT, guild_id TEXT, channel_id TEXT);
CREATE INDEX IF NOT EXISTS usage_at ON usage(at);
CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY, at INTEGER NOT NULL, user_id TEXT, username TEXT, media_type TEXT NOT NULL,
  tmdb_id INTEGER NOT NULL, seasons TEXT, title TEXT, outcome TEXT NOT NULL, status INTEGER, error TEXT);
CREATE INDEX IF NOT EXISTS requests_at ON requests(at);
CREATE TABLE IF NOT EXISTS people (user_id TEXT PRIMARY KEY, username TEXT, first_seen INTEGER NOT NULL, last_seen INTEGER NOT NULL);
`;

/** Main's subtitle cache (ae6000d): three columns added after the first, none of them `whole`. */
const MAIN_SUBTITLES = `
CREATE TABLE IF NOT EXISTS embedded_subtitles (stream_id TEXT PRIMARY KEY, rating_key TEXT NOT NULL, format TEXT NOT NULL,
  cues_json TEXT NOT NULL, cached_at INTEGER NOT NULL);
ALTER TABLE embedded_subtitles ADD COLUMN parser_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE embedded_subtitles ADD COLUMN raw BLOB;
ALTER TABLE embedded_subtitles ADD COLUMN fingerprint TEXT;
`;

const SRT = "1\n00:00:01,000 --> 00:00:02,500\nGood evening.\n\n2\n00:00:03,000 --> 00:00:04,000\nShall we begin?\n";

/** A folder of files as main and the first dashboard left them: one session watched two days ago, one subtitle read by main. */
function filesFromBefore(dir: string) {
  const t0 = Date.now() - 2 * DAY;
  const a = new Database(path.join(dir, "admin.sqlite"));
  a.pragma("journal_mode = WAL");
  a.exec(FIRST_RECORDER);
  a.prepare(`INSERT INTO plays (id, room_id, rating_key, title, guild_id, channel_id, host_user_id, started_at, updated_at, ended_at,
    end_reason, end_by, start_pos_s, last_pos_s, played_s, peak_viewers) VALUES (1, 'R1', '173916', 'Verity', 'g1', 'c1', 'u1', ?, ?, ?,
    'stopped', 'u1', 0, 3500, 3500, 2)`).run(t0, t0 + 3_600_000, t0 + 3_600_000);
  const viewer = a.prepare(`INSERT INTO play_viewers (play_id, user_id, username, role, first_seen, last_seen, watched_s, http_bytes, stalls, stalled_ms)
    VALUES (1, ?, ?, ?, ?, ?, 3500, 900000000, 1, 2500)`);
  viewer.run("u1", "alex", "host", t0, t0 + 3_600_000);
  viewer.run("u2", "sam", "viewer", t0 + 60_000, t0 + 3_600_000);
  a.prepare(`INSERT INTO play_streams (play_id, hls_session_id, variant_key, engine, decision, reason, summary, started_at, ended_at, peak_viewers)
    VALUES (1, 'h1', 'v1', 'ffmpeg', 'transcode', '10-bit picture: frames dropped on this player', 'HEVC to H.264', ?, ?, 2)`).run(t0, t0 + 3_600_000);
  const event = a.prepare("INSERT INTO events (play_id, room_id, at, kind, user_id, username, pos_s, detail) VALUES (1, 'R1', ?, ?, 'u1', 'alex', ?, NULL)");
  event.run(t0, "play", 0);
  event.run(t0 + 600_000, "pause", 600);
  event.run(t0 + 660_000, "resume", 600);
  event.run(t0 + 3_600_000, "stop", 3500);
  a.prepare("INSERT INTO usage (at, kind, room_id, user_id, username, guild_id, channel_id) VALUES (?, 'launch', 'R1', 'u1', 'alex', 'g1', 'c1')").run(t0 - 5_000);
  a.prepare("INSERT INTO requests (at, user_id, username, media_type, tmdb_id, title, outcome) VALUES (?, 'u2', 'sam', 'movie', 1, 'Beast', 'requested')").run(t0);
  const person = a.prepare("INSERT INTO people (user_id, username, first_seen, last_seen) VALUES (?, ?, ?, ?)");
  person.run("u1", "alex", t0, t0 + 3_600_000);
  person.run("u2", "sam", t0 + 60_000, t0 + 3_600_000);
  a.close();

  const s = new Database(path.join(dir, "subtitles.sqlite"));
  s.pragma("journal_mode = WAL");
  s.exec(MAIN_SUBTITLES);
  const row = s.prepare(`INSERT INTO embedded_subtitles (stream_id, rating_key, format, cues_json, cached_at, parser_version, raw, fingerprint)
    VALUES (?, '173916', 'srt', ?, ?, ?, ?, ?)`);
  // Read by main: its parser's cues, and the text they came from.
  row.run("s-main", JSON.stringify([{ start: 1, end: 2.5, text: "stale" }]), t0, 2, gzipSync(Buffer.from(SRT)), "fp-1");
  // Kept before the text was: read out of the film again.
  row.run("s-old", JSON.stringify([{ start: 1, end: 2, text: "x" }]), t0, 0, null, null);
  s.close();
}

function open(dir: string): { result: Record<string, unknown>; schema: Record<string, Record<string, string[]>> } {
  const r = spawnSync(process.execPath, [...process.execArgv, import.meta.filename, "open", dir],
    { encoding: "utf-8", env: { ...process.env }, timeout: 120_000 });
  const line = (r.stdout ?? "").split("\n").find((l) => l.startsWith("RESULT "));
  if (!line) {
    console.log(r.stdout, r.stderr);
    throw new Error(`opening ${dir} failed (exit ${r.status})`);
  }
  return JSON.parse(line.slice(7));
}

const before = fs.mkdtempSync(path.join(os.tmpdir(), "db-upgrade-before-"));
const fresh = fs.mkdtempSync(path.join(os.tmpdir(), "db-upgrade-fresh-"));
filesFromBefore(before);
const up = open(before);
const nw = open(fresh);

console.log("\n— the files after the update, against new ones —");
const files = Object.keys(nw.schema).sort();
check("the same files", Object.keys(up.schema).sort(), files);
for (const f of files) {
  const keys = [...new Set([...Object.keys(up.schema[f] ?? {}), ...Object.keys(nw.schema[f])])].sort();
  const differ = keys.filter((k) => JSON.stringify(up.schema[f]?.[k]) !== JSON.stringify(nw.schema[f][k]));
  check(`  ${f}: every table, column and index as a new file has them`, differ, []);
}

console.log("\n— the history from before, read —");
const r = up.result;
check("the session watched before the update", [r.plays, r.title, r.viewers], [1, "Verity", 2]);
check("  its events", r.events, ["play", "pause", "resume", "stop"]);
check("  the person page, the requests and the launches", [r.person, r.requests, r.usage], ["found", 1, 1]);
check("  counted in the statistics", r.sessionsInGraphs, 1);

console.log("\n— what is new, written to a file from before —");
check("a processing step", r.processing, [["probe", 1]]);
check("the server's load", r.loadPoints, 1);

console.log("\n— the subtitle cache from main —");
check("a subtitle read by main: parsed again from its kept text, not read out of the film again",
  r.subtitleOfMain, { state: "ready", cues: [{ start: 1, end: 2.5, text: "Good evening." }, { start: 3, end: 4, text: "Shall we begin?" }] });
check("  its text, for drawing into the picture", r.subtitleOfMainText, SRT);
check("  kept when main kept it", typeof r.subtitleOfMainKeptAt, "number");
check("a subtitle kept before its text was: read again", r.subtitleWithoutText, null);

console.log("\n— a new file —");
check("a new history is empty and readable", [nw.result.plays, nw.result.loadPoints], [0, 1]);

fs.rmSync(before, { recursive: true, force: true });
fs.rmSync(fresh, { recursive: true, force: true });
console.log(`\ndb-upgrade: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
