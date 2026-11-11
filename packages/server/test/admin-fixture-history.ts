/**
 * Made-up history for the admin fixture, so its graphs have something to
 * draw: about six weeks of evenings, each play recorded as on a real server
 * (rooms looked at every 10 seconds, players' samples, stalls, launches and
 * requests) by a recorder on a clock of its own.
 */
import type { Overview } from "../src/admin/data.js";

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
  "10-bit picture: frames dropped on this player", "Their player can't play HEVC",
  "Over the room's bandwidth: 20 Mbps", "Subtitles burned in: PGS", "10-bit picture: frames dropped on this player",
];
const ASKED: Array<[string, number, string]> = [
  ["movie", 129, "Spirited Away"], ["tv", 95396, "Severance"], ["movie", 4977, "Paprika"], ["tv", 1399, "Game of Thrones"],
  ["movie", 10494, "Perfect Blue"], ["movie", 13398, "Millennium Actress"],
];

/** Writes the history into `dbPath`, ending before `now`. */
export async function backfill(dbPath: string, now: number, days = 45): Promise<void> {
  const { Recorder } = await import("../src/admin/recorder.js");
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
        kbpsSource: null, plexTranscodeKey: null, plexClientId: null, notes: {}, notesAt: null,
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
          subtitleStreamId: 0, quality: 0, caps: [], av1Encode: false,
        })),
        streams,
      };
      rooms = [room];
      rec.transport({ at: g, roomId, type: "play", userId: hostId, username: people[0][1], role: "host", fromS: 0, toS: 0, ratingKey, title } as never);
      rec.tick(g);
      const start = g;
      people.forEach(([userId], i) => rec.clientLog({ at: g, userId, clientId: `past-${n}-${i}`, entries: [
        { t: g, level: "LOG", tag: "Health", msg: "sample", data: { session: "past", httpMB: 0, p2pMB: 0, edgeHitMB: "0", edgeMB: "0" } },
      ] }));
      const length = Math.round(minutes * (0.4 + rnd() * 0.6)) * 60_000;
      while (g - start < length) {
        g += 10_000;
        room.positionS = (g - start) / 1000;
        rec.tick(g);
      }
      people.forEach(([userId], i) => {
        const mb = ((g - start) / 1000) * (reencode ? 0.5 : 1.1) * (0.8 + rnd() * 0.4);
        const hit = 0.25 + rnd() * 0.5;
        const entries: Any[] = [{ t: g, level: "LOG", tag: "Health", msg: "sample", data: {
          session: "past", httpMB: mb, p2pMB: i > 0 && rnd() < 0.4 ? mb * 0.2 : 0, edgeHitMB: (mb * hit).toFixed(1), edgeMB: (mb * 0.9).toFixed(1),
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
      if (rnd() < 0.5) rec.transport({ at: g, roomId, type: "stop", userId: hostId, username: people[0][1], role: "host", fromS: room.positionS, toS: room.positionS } as never);
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
}
