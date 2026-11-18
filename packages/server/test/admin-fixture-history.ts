/**
 * Made-up history for the admin fixture, so its graphs have something to
 * draw: about six weeks of evenings, each play recorded as on a real server
 * (rooms looked at every 10 seconds, players' samples, stalls, launches and
 * requests) by a recorder on a clock of its own.
 */
import type { Overview } from "../src/admin/data.js";

// Clients as their players give them on joining: the user agents of the
// Discord desktop app, its iPhone and Android apps, Vesktop, and browsers.
export const AGENTS = {
  desktop: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) discord/1.0.9268 Chrome/138.0.7204.251 Electron/44.0.0 Safari/537.36",
  iphone: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148",
  android: "Mozilla/5.0 (Linux; Android 15; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36",
  vesktop: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) vesktop/1.6.9 Chrome/140.0.0.0 Electron/38.0.0 Safari/537.36",
  firefox: "Mozilla/5.0 (X11; Linux x86_64; rv:145.0) Gecko/20100101 Firefox/145.0",
  chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36 Edg/142.0.0.0",
};

type Any = Record<string, unknown>;
type Inst = { hostUserId: string; guildId: string | null; channelId: string | null; createdAt: number };

const DAY = 86_400_000;
const PEOPLE: Array<[string, string]> = [
  ["100000000000000001", "alex"], ["402115789012345678", "kit"], ["402115789012345679", "jo"],
  ["402115789012345680", "robin"], ["200000000000000001", "nightowl"], ["200000000000000002", "marlowe"],
  ["300000000000000001", "lurker"], ["300000000000000002", "velvetfog"], ["300000000000000003", "quietstorm"],
];
const TITLES: Array<[string, string, number]> = [
  ["58859", "Ghost Stories — S01E01", 24], ["58860", "Ghost Stories — S01E02", 24], ["80001", "Perfect Blue", 81],
  ["80002", "Paprika", 90], ["80003", "Tokyo Godfathers", 92], ["173951", "The Long Goodbye", 112],
  ["95397", "Severance — S01E01", 57], ["129", "Spirited Away", 125], ["80004", "Millennium Actress", 87],
];
const GUILDS: Array<[string, string]> = [["999000111", "888000111"], ["777000222", "666000222"], ["555000333", "444000333"]];
const REASONS = [
  "10-bit picture: frames dropped on this player", "HEVC: not decoded by this player",
  "Over the room's bandwidth: 20 Mbps", "Subtitles burned in: PGS", "10-bit picture: frames dropped on this player",
];
const ASKED: Array<[string, number, string]> = [
  ["movie", 129, "Spirited Away"], ["tv", 95396, "Severance"], ["movie", 4977, "Paprika"], ["tv", 1399, "Game of Thrones"],
  ["movie", 10494, "Perfect Blue"], ["movie", 13398, "Millennium Actress"],
];

/** Writes the history into `dbPath`, ending before `now`. */
export async function backfill(dbPath: string, now: number, days = 45): Promise<void> {
  const { Recorder } = await import("../src/admin/recorder.js");
  /** A player's key, as its peer id carries it. */
  const keyOf = (id: string) => `K${id.slice(0, 1)}${id.slice(-6)}`;
  let seed = 7;
  const rnd = () => (seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648;
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length)];
  let g = (Math.floor(now / DAY) - days) * DAY;
  let rooms: Any[] = [];
  const inst = new Map<string, Inst>();
  const rec = new Recorder({ dbPath, now: () => g, instances: () => inst,
    source: () => ({ at: g, totals: {}, rooms }) as unknown as Overview });
  let n = 0;
  for (let d = Math.floor(now / DAY) - days; d < Math.floor(now / DAY); d++) {
    const weekday = (d + 4) % 7;
    const plays = Math.floor(rnd() * (weekday === 5 || weekday === 6 ? 5 : 3.2));
    let clock = d * DAY + (17 + Math.floor(rnd() * 4)) * 3_600_000 + Math.floor(rnd() * 3_600_000);
    for (let p = 0; p < plays; p++) {
      n++;
      const [ratingKey, title, minutes] = pick(TITLES);
      if (clock + minutes * 60_000 > now - 5 * 60_000) break;
      const [guildId, channelId] = pick(GUILDS);
      const people = [...PEOPLE].sort(() => rnd() - 0.5).slice(0, 1 + Math.floor(rnd() * 4));
      const [hostId] = people[0];
      const roomId = `i-${n}-past`;
      g = clock;
      inst.set(roomId, { hostUserId: hostId, guildId, channelId, createdAt: g });
      const reencode = rnd() < 0.35;
      const streams: Any[] = [{
        variantKey: "v0", hlsSessionId: `past-${n}-0`, audioStreamId: 1, subtitleStreamId: 0, quality: 0, ownerUserId: null,
        sessionOffset: 0, idleS: null, viewers: people.map(([id]) => id), isHostStream: true, engine: "ffmpeg",
        decision: reencode ? "transcode" : "copy", reason: reencode ? pick(REASONS) : null, summary: "", kbps: reencode ? 4000 : 8000 + Math.floor(rnd() * 10_000),
        kbpsSource: null, plexTranscodeKey: null, plexClientId: null,
        notes: reencode && n % 6 === 0 ? { range: "HDR10 → SDR (tone-mapped)" } : {}, notesAt: null,
      }];
      if (people.length > 1 && rnd() < 0.3) {
        const own = people[people.length - 1][0];
        (streams[0].viewers as string[]).pop();
        streams.push({ ...streams[0], variantKey: "v1", hlsSessionId: `past-${n}-1`, viewers: [own], isHostStream: false,
          ownerUserId: own, decision: "transcode", reason: pick(REASONS), kbps: 4000 });
      }
      const room: Any = {
        id: roomId, ratingKey, title, playing: true, positionS: 0, waiting: false, hostWaiting: false, stateAgeS: 0,
        hostHeartbeatAgeS: 0, hostVariantKey: "v0", hostSubtitleId: 0, coHostIds: [], queue: [], heldFor: null, away: [],
        discord: { guildId, channelId, hostUserId: hostId, startedAt: g },
        clients: people.map(([userId, username], i) => ({
          userId, username, role: i === 0 ? "host" : "viewer", connected: true, watching: true, away: false, loading: false,
          joinedAt: g, variantKey: streams.find((s) => (s.viewers as string[]).includes(userId))?.variantKey ?? "v0",
          subtitleStreamId: 0, quality: 0, caps: i === 0 ? ["hevc", "opus", "eac3"] : (i + n) % 2 ? ["hevc"] : [], av1Encode: false,
          device: [AGENTS.desktop, AGENTS.firefox, AGENTS.chrome, AGENTS.vesktop, AGENTS.edge][(i + n) % 5],
        })),
        streams,
      };
      rooms = [room];
      // Everyone is in the room a moment before the host chooses the title, as they are.
      Object.assign(room, { ratingKey: null, title: null, playing: false });
      rec.tick(g);
      g += 15_000;
      Object.assign(room, { ratingKey, title, playing: true });
      // How long the server took to prepare it: the file's probe, each stream's setup and first segment, a subtitle.
      for (const s of streams) {
        const enc = s.decision === "transcode";
        rec.processing({ at: g - 3_000, kind: "probe", hlsSessionId: s.hlsSessionId, ratingKey, ms: 250 + Math.floor(rnd() * 600), ok: true, detail: { streams: 3, from: "file" } });
        rec.processing({ at: g - 2_000, kind: "stream setup", hlsSessionId: s.hlsSessionId, ratingKey, ms: 600 + Math.floor(rnd() * (enc ? 1500 : 700)), ok: true, detail: { encode: enc, fromS: 0 } });
        rec.processing({ at: g, kind: "first segment", hlsSessionId: s.hlsSessionId, ratingKey, ms: (enc ? 1800 : 700) + Math.floor(rnd() * (enc ? 2500 : 900)), ok: true, detail: { encode: enc, fromS: 0 } });
      }
      if (n % 3 === 0) rec.processing({ at: g + 4_000, kind: "subtitle", hlsSessionId: null, ratingKey, ms: 900 + Math.floor(rnd() * 4000), ok: n % 15 !== 0,
        detail: n % 15 !== 0 ? { streamId: 3, by: "ffmpeg", format: "srt", cues: 380, whole: true } : { streamId: 3, why: "The data read was not a subtitle" } });
      if (ratingKey === "80002") rec.streamIssue({ at: g, hlsSessionId: `past-${n}-0`, ratingKey, kind: "short sound",
        detail: { soundEndsS: minutes * 60 - 22.5, pictureEndsS: minutes * 60 } });
      rec.transport({ at: g, roomId, type: "play", userId: hostId, username: people[0][1], role: "host", fromS: 0, toS: 0, ratingKey, title } as never);
      rec.tick(g);
      const start = g;
      people.forEach(([userId], i) => {
        const loadMs = 700 + Math.floor(rnd() * 3_500);
        rec.clientLog({ at: g + loadMs + 200, userId, clientId: `past-${n}-${i}`, entries: [
          { t: g, level: "LOG", tag: "Health", msg: "sample", data: { session: "past", httpMB: 0, p2pMB: 0, edgeHitMB: "0", edgeMB: "0", peerKey: keyOf(userId) } },
          { t: g + 100, level: "WARN", tag: "Video", msg: "waiting (buffer starved)", data: { posS: 0, paused: false, seeking: false, readyState: 0 } },
          { t: g + 100 + loadMs, level: "LOG", tag: "Video", msg: "playing", data: { posS: 0, paused: false, seeking: false, readyState: 3 } },
        ] as never });
      });
      const length = Math.round(minutes * (0.4 + rnd() * 0.6)) * 60_000;
      // What each will have had by the end, and from the others: known now so each sample can say its share so far.
      const had = people.map(() => (length / 1000) * (reencode ? 0.5 : 1.1) * (0.8 + rnd() * 0.4));
      const got = had.map((mb, i) => (i > 0 && rnd() < 0.4 ? mb * 0.2 : 0));
      const hits = people.map(() => 0.25 + rnd() * 0.5);
      const detailed = d >= Math.floor(now / DAY) - 10;
      // Every other session somebody pauses a quarter of the way in, for a while; every fifth, a viewer asks for host.
      const pauseAt = n % 2 === 0 ? Math.round(length / 4 / 10_000) * 10_000 : null;
      const pauser = people[Math.floor(rnd() * people.length)];
      const pauseFor = (2 + Math.floor(rnd() * 8)) * 10_000;
      let pausedS = 0;
      // Every third session one viewer switches away from the Discord window for a few minutes.
      const awayAt = n % 3 === 1 && people.length > 1 ? Math.round(length / 2 / 10_000) * 10_000 : null;
      // Every third session: Skip Intro, then a seek back and one forward on the timeline.
      const seeks: Array<[number, number, string]> = n % 3 === 0
        ? [[30_000, 75, "skip intro"], [Math.round((length * 0.4) / 10_000) * 10_000, -300, "timeline"],
          [Math.round((length * 0.65) / 10_000) * 10_000, 600, "timeline"]]
        : [];
      let ahead = 0;
      // Every third session the last viewer moves to the Discord app on their phone halfway in.
      const moves = n % 3 === 0 && people.length > 1 ? Math.round(length / 2 / 10_000) * 10_000 : null;
      while (g - start < length) {
        g += 10_000;
        if (pauseAt !== null && g - start === pauseAt) {
          rec.transport({ at: g, roomId, type: "pause", userId: pauser[0], username: pauser[1], role: pauser === people[0] ? "host" : "viewer",
            fromS: room.positionS, toS: room.positionS, ratingKey, title } as never);
          room.playing = false;
        }
        if (pauseAt !== null && g - start === pauseAt + pauseFor) {
          rec.transport({ at: g, roomId, type: "resume", userId: hostId, username: people[0][1], role: "host",
            fromS: room.positionS, toS: room.positionS, ratingKey, title } as never);
          room.playing = true;
        }
        if (!room.playing) pausedS += 10;
        if (awayAt !== null && g - start === awayAt) room.clients[1].away = true;
        if (awayAt !== null && g - start === awayAt + 180_000) room.clients[1].away = false;
        if (n % 5 === 0 && people.length > 1 && g - start === 60_000) {
          rec.hostRequest({ at: g, roomId, outcome: "asked", userId: people[1][0], username: people[1][1], hostId, hostName: people[0][1],
            away: false, waitS: 120 });
        }
        if (n % 5 === 0 && people.length > 1 && g - start === 80_000) {
          rec.hostRequest({ at: g, roomId, outcome: n % 10 === 0 ? "declined" : "ended", userId: people[1][0], username: people[1][1],
            hostId, hostName: people[0][1], ...(n % 10 === 0 ? {} : { why: "host changed" as const }) });
        }
        if (moves !== null && g - start === moves) room.clients.at(-1).device = AGENTS.iphone;
        // Every fourth session the host makes the second person co-host a third of the way in,
        // and hands them host two thirds in, staying on as co-host.
        if (n % 4 === 0 && people.length > 2) {
          const third = Math.round(length / 3 / 10_000) * 10_000;
          if (g - start === third) {
            room.roleWhy = { at: g, why: "co-host given", by: people[0][1], to: people[1][1] };
            room.clients[1].role = "co-host";
          }
          if (g - start === third * 2) {
            room.roleWhy = { at: g, why: "handed over", by: people[0][1], to: people[1][1] };
            Object.assign(room.clients[0], { role: "co-host" });
            Object.assign(room.clients[1], { role: "host" });
          }
        }
        const seek = seeks.find(([after]) => after === g - start);
        if (seek) {
          const fromS = (g - start) / 1000 + ahead - pausedS;
          ahead = Math.max(-(g - start) / 1000, ahead + seek[1]);
          rec.transport({ at: g, roomId, type: "seek", userId: hostId, username: people[0][1], role: "host", fromS,
            toS: (g - start) / 1000 + ahead - pausedS, ratingKey, title, cause: seek[2] } as never);
        }
        room.positionS = (g - start) / 1000 + ahead - pausedS;
        rec.tick(g);
        if (detailed) {
          const share = Math.min(1, (g - start) / length);
          people.forEach(([userId], i) => rec.clientLog({ at: g, userId, clientId: `past-${n}-${i}`, entries: [{ t: g, level: "LOG", tag: "Health", msg: "sample", data: {
            session: "past", httpMB: had[i] * share, p2pMB: got[i] * share, edgeHitMB: (had[i] * share * hits[i]).toFixed(1),
            edgeMB: (had[i] * share * 0.9).toFixed(1), peerKey: keyOf(userId),
            posS: Math.max(0, (room.positionS as number) - (i ? 0.4 * i : 0)), paused: !room.playing, playedS: room.playing ? 10 : 0,
            // How far each viewer's player is from the room, and what it has ahead: the last viewer's runs short now and then.
            driftS: i === 0 ? "n/a(host)" : Math.round(Math.sin((g - start) / 40_000 + i) * (i === people.length - 1 ? 2.6 : 0.5) * 100) / 100,
            downloadedAheadS: Math.round((i === people.length - 1 ? 6 + Math.abs(Math.sin((g - start) / 90_000)) * 30 : 30 + Math.sin((g - start) / 60_000 + i) * 8) * 10) / 10,
            bufAheadS: 20, peers: people.length - 1, heapUsedMB: 160 + i * 25,
            framesShown: room.playing ? 240 : 0, framesDropped: room.playing && i === people.length - 1 && ((g - start) / 10_000) % 9 === 0 ? 12 : 0,
          } }] as never }));
        }
      }
      // Who sent what each had from the others: the one before them, or the host.
      const sent = people.map(() => ({} as Record<string, number>));
      got.forEach((mb, i) => {
        if (mb <= 0) return;
        const from = rnd() < 0.6 ? 0 : i - 1;
        sent[from][keyOf(people[i][0])] = (sent[from][keyOf(people[i][0])] ?? 0) + mb;
      });
      people.forEach(([userId], i) => {
        const mb = had[i];
        const hit = hits[i];
        const upMB = Object.values(sent[i]).reduce((a, b) => a + b, 0);
        const entries: Any[] = [{ t: g, level: "LOG", tag: "Health", msg: "sample", data: {
          session: "past", httpMB: mb, p2pMB: got[i], edgeHitMB: (mb * hit).toFixed(1), edgeMB: (mb * 0.9).toFixed(1),
          peerKey: keyOf(userId), ...(upMB > 0 ? { upMB, upTo: sent[i] } : {}),
        } }];
        if (rnd() < 0.25) {
          const at = start + Math.floor(rnd() * (g - start - 60_000)) + 30_000;
          entries.unshift(
            { t: at, level: "WARN", tag: "Video", msg: "waiting (buffer starved)", data: { posS: (at - start) / 1000, paused: false, seeking: false } },
            { t: at + 800 + Math.floor(rnd() * 6_000), level: "LOG", tag: "Video", msg: "playing", data: { posS: (at - start) / 1000, paused: false, seeking: false } },
          );
        }
        rec.clientLog({ at: g, userId, clientId: `past-${n}-${i}`, entries: entries as never });
      });
      g += 2_000;
      rec.tick(g);
      if (rnd() < 0.5) rec.transport({ at: g, roomId, type: "stop", userId: hostId, username: people[0][1], role: "host", fromS: room.positionS, toS: room.positionS,
        ...(n % 3 === 0 ? { cause: "finished" } : {}) } as never);
      rooms = [];
      g += 2_000;
      rec.tick(g);
      inst.delete(roomId);
      clock = g + (10 + Math.floor(rnd() * 50)) * 60_000;
    }
    if (rnd() < 0.45) {
      const [mediaType, tmdbId, title] = pick(ASKED);
      const [userId] = pick(PEOPLE);
      g = Math.max(g, d * DAY + (12 + Math.floor(rnd() * 10)) * 3_600_000);
      const fresh = rnd() < 0.8;
      if (g > now - 5 * 60_000) continue;
      rec.request({ at: g, userId, mediaType, tmdbId, seasons: mediaType === "tv" ? "all" : null,
        outcome: fresh ? "requested" : "already requested", status: fresh ? 2 : 409, error: null,
        title: Promise.resolve(title) } as never);
    }
  }
  await new Promise((r) => setTimeout(r, 50));
  rec.close();

  // The server's load a minute at a time over the last week, as the System page charts it: busier while something played.
  const { default: Database } = await import("better-sqlite3");
  const db = new Database(dbPath);
  const busy = db.prepare(`SELECT p.started_at AS s, COALESCE(p.ended_at, p.updated_at) AS e,
      (SELECT COUNT(*) FROM play_streams x WHERE x.play_id = p.id) AS n,
      (SELECT COUNT(*) FROM play_streams x WHERE x.play_id = p.id AND x.decision = 'transcode') AS t,
      (SELECT COUNT(*) FROM play_viewers v WHERE v.play_id = p.id) AS v
    FROM plays p WHERE COALESCE(p.ended_at, p.updated_at) >= ?`).all(now - 7 * DAY) as Array<{ s: number; e: number; n: number; t: number; v: number }>;
  const put = db.prepare(`INSERT INTO system_load (minute, cpu_pct, bot_cpu_pct, mem_pct, rss_mb, load1, streams, encodes, viewers)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (minute) DO UPDATE SET cpu_pct = excluded.cpu_pct, bot_cpu_pct = excluded.bot_cpu_pct,
        mem_pct = excluded.mem_pct, rss_mb = excluded.rss_mb, load1 = excluded.load1,
        streams = MAX(streams, excluded.streams), encodes = MAX(encodes, excluded.encodes), viewers = MAX(viewers, excluded.viewers)`);
  const r1 = (v: number) => Math.round(v * 10) / 10;
  db.transaction(() => {
    for (let m = Math.floor((now - 7 * DAY) / 60_000); m < Math.floor(now / 60_000) - 1; m++) {
      const t = m * 60_000;
      const on = busy.filter((p) => p.s <= t && t <= p.e);
      const streams = on.reduce((a, p) => a + p.n, 0);
      const encodes = on.reduce((a, p) => a + p.t, 0);
      const viewers = on.reduce((a, p) => a + p.v, 0);
      const wave = Math.sin((t / DAY) * 2 * Math.PI) * 2.5;
      const cpu = Math.min(100, 6 + wave + rnd() * 4 + streams * 4 + encodes * 21);
      const bot = Math.min(cpu, 0.6 + rnd() * 0.6 + streams * 1.4 + encodes * 0.4);
      const mem = 41 + wave / 2 + rnd() * 1.5 + streams * 1.8 + encodes * 3.5;
      put.run(m, r1(cpu), r1(bot), r1(mem), r1(170 + rnd() * 12 + streams * 38), Math.round((cpu / 100) * 8 * 100) / 100, streams, encodes, viewers);
    }
  })();
  db.close();
}
