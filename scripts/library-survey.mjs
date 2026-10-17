#!/usr/bin/env node
/**
 * How much of the library could Discord play as-is?
 *
 *   node scripts/library-survey.mjs
 *
 * Reads Plex's own metadata for every movie and episode — no file is opened or
 * downloaded, so it takes seconds — and sorts each title by what Discord's
 * Chromium could do with the file the app would play:
 *
 *   Direct Play now            container, video and default audio all play in
 *                              Chromium as they are
 *   Direct Play if HEVC        the same, but the video is HEVC, which plays only
 *                              where every viewer's GPU decodes it
 *   Audio needs converting     the picture would play but the default audio is
 *                              AC3, E-AC3, DTS or TrueHD, which Chromium can't
 *   Needs a transcode          video or container Chromium can't play at all
 *                              (MPEG-2, VC-1, 10-bit H.264, AVI, TS, …)
 *   4K only                    the only copy is 4K, which the app transcodes down
 *
 * MKV counts as playable: Chromium plays Matroska through a plain <video>
 * element, though it doesn't advertise it. That, and whether Discord's proxy
 * passes byte ranges through, are the two things to try in Discord itself
 * before relying on this.
 *
 * Needs Node 18+, and PLEX_URL and PLEX_TOKEN (environment, or --plex-url /
 * --plex-token). On a host without a new enough Node:
 *
 *   docker run --rm -it --network host -v "$PWD":/work -w /work node:22-alpine \
 *     node library-survey.mjs --plex-url http://… --plex-token …
 *
 * Also writes every title and its verdict to library-survey-<time>.csv, in
 * /data/diagnose inside the container and diagnose-out/ elsewhere.
 */

import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

// ─── Arguments ──────────────────────────────────────────────────

const HELP = `
Usage: node scripts/library-survey.mjs [options]

  --plex-url <url>      Overrides PLEX_URL.
  --plex-token <token>  Overrides PLEX_TOKEN.
  --section <id>        Only this library section (repeatable).
  --out <file>          CSV path (default <data>/diagnose/library-survey-<time>.csv).
  --streams             Also read every title's streams, one request each: HDR
                        type, Dolby Vision profile, interlacing, picture
                        subtitles. Minutes rather than seconds on a big library.
`;

const args = { section: [] };
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const name = argv[i].replace(/^--/, "");
  if (name === "help") {
    console.log(HELP);
    process.exit(0);
  }
  if (name === "streams") {
    args.streams = true;
    continue;
  }
  const value = argv[++i];
  if (!["plex-url", "plex-token", "section", "out"].includes(name) || value === undefined) {
    console.error(`Unexpected argument: ${argv[i - 1]}`, HELP);
    process.exit(2);
  }
  if (name === "section") args.section.push(value);
  else args[name] = value;
}

const PLEX_URL = (args["plex-url"] ?? process.env.PLEX_URL ?? "").replace(/\/$/, "");
const PLEX_TOKEN = args["plex-token"] ?? process.env.PLEX_TOKEN ?? "";
if (!PLEX_URL || !PLEX_TOKEN) {
  console.error("Set PLEX_URL and PLEX_TOKEN (or pass --plex-url / --plex-token).");
  process.exit(2);
}
// Inside the container, the data volume, where the host can reach it.
const OUT_DIR = existsSync("/data") ? "/data/diagnose" : "diagnose-out";
const CSV_PATH = path.resolve(
  args.out ?? path.join(OUT_DIR, `library-survey-${new Date().toISOString().replace(/[:.]/g, "-")}.csv`),
);

// ─── Plex ───────────────────────────────────────────────────────

async function plexJSON(p, params = {}) {
  const url = new URL(`${PLEX_URL}${p}`);
  url.searchParams.set("X-Plex-Token", PLEX_TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json", "X-Plex-Client-Identifier": "pdt-library-survey", "X-Plex-Product": "Plex Discord Theater" },
      signal: controller.signal,
    });
    if (!res.ok) throw new Error(`${p} → HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Every item of one type in a section, a page at a time. */
async function allItems(sectionId, type) {
  const items = [];
  const pageSize = 500;
  for (let start = 0; ; start += pageSize) {
    const data = await plexJSON(`/library/sections/${sectionId}/all`, {
      type,
      "X-Plex-Container-Start": start,
      "X-Plex-Container-Size": pageSize,
    });
    const page = data.MediaContainer?.Metadata ?? [];
    items.push(...page);
    const total = data.MediaContainer?.totalSize ?? items.length;
    process.stdout.write(`\r  section ${sectionId}: ${items.length} / ${total}   `);
    if (page.length < pageSize || items.length >= total) break;
  }
  process.stdout.write("\n");
  return items;
}

// ─── What Chromium can play ─────────────────────────────────────

// The same version the app would play: 4K hidden whenever anything else
// exists, then widest, then highest bitrate (media-versions.ts).
const UHD_MIN_WIDTH = 3000;
const RESOLUTION_WIDTHS = { "4k": 3840, 2160: 3840, 1080: 1920, 720: 1280, 576: 1024, 480: 854, sd: 720 };
function frameWidth(m) {
  if (m.width > 0) return m.width;
  const known = RESOLUTION_WIDTHS[String(m.videoResolution ?? "").toLowerCase()];
  if (known) return known;
  return m.height > 0 ? Math.round((m.height * 16) / 9) : 0;
}
function defaultVersion(media) {
  const anyUhd = media.some((m) => frameWidth(m) >= UHD_MIN_WIDTH);
  const anyOther = media.some((m) => frameWidth(m) < UHD_MIN_WIDTH);
  const playable = anyUhd && anyOther ? media.filter((m) => frameWidth(m) < UHD_MIN_WIDTH) : [...media];
  playable.sort((a, b) => frameWidth(b) - frameWidth(a) || (b.bitrate ?? 0) - (a.bitrate ?? 0));
  return playable[0];
}

const PLAYABLE_CONTAINERS = new Set(["mp4", "m4v", "mov", "mkv", "webm"]);
const PLAYABLE_AUDIO = new Set(["aac", "mp3", "opus", "flac", "vorbis"]);
const CONVERTIBLE_AUDIO = new Set(["ac3", "eac3", "dca", "dts", "dca-ma", "truehd", "mlp"]);

const VERDICTS = {
  now: "Direct Play now",
  hevc: "Direct Play if the room can play HEVC",
  audio: "Picture plays, audio needs converting",
  transcode: "Needs a transcode",
  uhd: "4K only",
  none: "No media info",
};

/** The verdict for one version, and the reason when it isn't playable. */
function classify(m) {
  if (!m) return { verdict: "none", reason: "no media" };
  const container = String(m.container ?? "").toLowerCase();
  const video = String(m.videoCodec ?? "").toLowerCase();
  const profile = String(m.videoProfile ?? "").toLowerCase();
  const audio = String(m.audioCodec ?? "").toLowerCase();
  if (frameWidth(m) >= UHD_MIN_WIDTH) return { verdict: "uhd", reason: `4K ${video}` };
  if (!PLAYABLE_CONTAINERS.has(container)) return { verdict: "transcode", reason: `container ${container || "?"}` };

  let videoOk;
  let hevc = false;
  if (video === "h264") {
    // 10-bit and 4:2:2 H.264 have no decoder in Chromium.
    videoOk = !/10|422|444/.test(profile);
  } else if (video === "hevc") {
    videoOk = true;
    hevc = true;
  } else {
    videoOk = ["av1", "vp9", "vp8"].includes(video);
  }
  if (!videoOk) return { verdict: "transcode", reason: `video ${video || "?"}${profile ? ` ${profile}` : ""}` };

  if (!audio || PLAYABLE_AUDIO.has(audio)) return { verdict: hevc ? "hevc" : "now", reason: "" };
  if (CONVERTIBLE_AUDIO.has(audio)) return { verdict: "audio", reason: `audio ${audio}` };
  return { verdict: "transcode", reason: `audio ${audio}` };
}

// ─── Streams (--streams) ────────────────────────────────────────

/** HDR as Plex describes a video stream. */
function hdrOf(v) {
  if (!v) return "SDR";
  if (v.DOVIPresent || v.DOVIProfile != null) {
    const p = Number(v.DOVIProfile);
    const bl = Number(v.DOVIBLCompatID);
    if (p === 8) return bl === 1 ? "DV P8.1" : bl === 4 ? "DV P8.4" : bl === 2 ? "DV P8.2" : "DV P8";
    // AV1's Dolby Vision: 10.1 has an HDR10 picture underneath, 10.0 nothing, like 5.
    if (p === 10) return bl === 1 ? "DV P10.1" : bl === 4 ? "DV P10.4" : bl === 2 ? "DV P10.2" : "DV P10.0";
    return Number.isFinite(p) ? `DV P${p}` : "DV";
  }
  const trc = String(v.colorTrc ?? "").toLowerCase();
  if (trc === "smpte2084") return "HDR10";
  if (trc === "arib-std-b67") return "HLG";
  return "SDR";
}

const PICTURE_SUBTITLES = new Set(["pgs", "vobsub", "dvd_subtitle", "dvb_subtitle", "hdmv_pgs_subtitle"]);

/** Run `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  }));
}

/** Each row's streams, from the title's own metadata — the listings leave them out. */
async function readStreams(rows) {
  let done = 0;
  await pool(rows, 8, async (r) => {
    try {
      const meta = (await plexJSON(`/library/metadata/${r.ratingKey}`)).MediaContainer?.Metadata?.[0];
      const media = (meta?.Media ?? []).find((m) => m.id === r.mediaId) ?? meta?.Media?.[0];
      const streams = media?.Part?.[0]?.Stream ?? [];
      const v = streams.find((s) => s.streamType === 1);
      r.hdr = hdrOf(v);
      r.doviProfile = v?.DOVIProfile ?? "";
      r.colorTrc = v?.colorTrc ?? "";
      r.scanType = v?.scanType ?? "";
      r.pictureSubs = streams.filter((s) => s.streamType === 3 && PICTURE_SUBTITLES.has(String(s.codec ?? "").toLowerCase())).length;
      r.anamorphic = v?.anamorphic ? (v.pixelAspectRatio ?? "yes") : "";
    } catch {
      r.hdr = "unread";
    }
    if (++done % 250 === 0 || done === rows.length) process.stdout.write(`\r  streams: ${done} / ${rows.length}   `);
  });
  process.stdout.write("\n");
}

function printStreams(rows) {
  const copyLimit = Number(process.env.DIRECT_STREAM_MAX_KBPS) || Number(process.env.VIDEO_BITRATE_KBPS) || 12000;
  const count = (f) => rows.filter(f).length;
  console.log(`\nHDR (of ${rows.length} titles)`);
  const kinds = {};
  for (const r of rows) kinds[r.hdr] = (kinds[r.hdr] ?? 0) + 1;
  for (const [k, n] of Object.entries(kinds).sort((a, b) => b[1] - a[1])) {
    const note = k === "DV P5" || k === "DV P10.0" ? "   no HDR10 base layer: can't be copied to a browser"
      : k.startsWith("DV") || k === "HDR10" || k === "HLG" ? "   copied like any HEVC file" : "";
    console.log(`  ${k.padEnd(10)} ${String(n).padStart(6)}  ${pct(n, rows.length).padStart(4)}${note}`);
  }
  const hdr = rows.filter((r) => !["SDR", "unread", "DV P8.2", "DV P10.2"].includes(r.hdr));
  console.log(`  HDR averaging over ${copyLimit} kbps (re-encoded, HDR kept): ${count((r) => hdr.includes(r) && r.bitrate > copyLimit)}`);
  console.log(`Interlaced: ${count((r) => /interlaced/i.test(r.scanType))} · anamorphic: ${count((r) => r.anamorphic)} · with picture subtitles (PGS/VobSub): ${count((r) => r.pictureSubs > 0)}`);
  const examples = [
    ["HDR10", (r) => r.hdr === "HDR10"], ["HLG", (r) => r.hdr === "HLG"], ["DV P8.1", (r) => r.hdr === "DV P8.1"],
    ["DV P7", (r) => r.hdr === "DV P7"], ["DV P5", (r) => r.hdr === "DV P5"],
    ["DV P10 (AV1)", (r) => r.hdr.startsWith("DV P10")],
    ["HDR over the copy limit", (r) => hdr.includes(r) && r.bitrate > copyLimit],
    ["interlaced", (r) => /interlaced/i.test(r.scanType)], ["AV1", (r) => r.videoCodec === "av1"],
    ["picture subtitles", (r) => r.pictureSubs > 0],
  ];
  console.log("\nTitles to try with: node scripts/diagnose-ffmpeg.mjs file --rating-key <id>");
  for (const [label, f] of examples) {
    const picks = rows.filter(f).slice(0, 3);
    if (picks.length) console.log(`  ${label.padEnd(24)} ${picks.map((r) => `${r.ratingKey} ${r.title}`).join("  ·  ")}`);
  }
}

// ─── Survey ─────────────────────────────────────────────────────

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

const mbps = (kbps) => (kbps == null ? "—" : `${(kbps / 1000).toFixed(1)} Mbps`);
const pct = (n, total) => (total ? `${Math.round((n / total) * 100)}%` : "—");

function tally(rows) {
  const out = {};
  for (const key of Object.keys(VERDICTS)) out[key] = { count: 0, bitrates: [], reasons: {}, containers: {} };
  for (const r of rows) {
    const t = out[r.verdict];
    t.count++;
    if (r.bitrate) t.bitrates.push(r.bitrate);
    if (r.reason) t.reasons[r.reason] = (t.reasons[r.reason] ?? 0) + 1;
    t.containers[r.container] = (t.containers[r.container] ?? 0) + 1;
  }
  return out;
}

function topOf(counts, n = 6) {
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `${k} ${v}`).join(" · ");
}

function printGroup(title, rows) {
  console.log(`\n${title} — ${rows.length} titles`);
  const t = tally(rows);
  for (const [key, label] of Object.entries(VERDICTS)) {
    const g = t[key];
    if (g.count === 0) continue;
    const med = median(g.bitrates);
    let detail = "";
    if (key === "now" || key === "hevc") detail = `by container: ${topOf(g.containers)}`;
    else if (key === "audio" || key === "transcode") detail = topOf(g.reasons);
    console.log(`  ${label.padEnd(40)} ${String(g.count).padStart(6)}  ${pct(g.count, rows.length).padStart(4)}   median ${mbps(med).padEnd(10)} ${detail}`);
  }
  return t;
}

async function main() {
  console.log(`Library survey · ${new Date().toISOString()} · Plex ${PLEX_URL}`);
  const sections = (await plexJSON("/library/sections")).MediaContainer?.Directory ?? [];
  const wanted = sections.filter((s) =>
    (s.type === "movie" || s.type === "show") && (args.section.length === 0 || args.section.includes(String(s.key))),
  );
  if (wanted.length === 0) {
    console.error("No movie or TV sections found.");
    process.exit(1);
  }

  const rows = [];
  for (const s of wanted) {
    console.log(`Reading "${s.title}" (${s.type === "show" ? "episodes" : "movies"})…`);
    // 1 = movie, 4 = episode.
    const items = await allItems(s.key, s.type === "show" ? 4 : 1);
    for (const item of items) {
      const media = item.Media ?? [];
      const chosen = media.length ? defaultVersion(media) : undefined;
      const { verdict, reason } = classify(chosen);
      // A title whose default doesn't play as-is, but another of its versions would.
      const otherPlays = verdict !== "now" && media.some((m) => m !== chosen && classify(m).verdict === "now");
      rows.push({
        section: s.title,
        kind: s.type === "show" ? "episode" : "movie",
        ratingKey: item.ratingKey,
        title: s.type === "show"
          ? `${item.grandparentTitle} S${item.parentIndex ?? "?"}E${item.index ?? "?"}`
          : `${item.title}${item.year ? ` (${item.year})` : ""}`,
        verdict,
        reason,
        otherPlays,
        container: String(chosen?.container ?? ""),
        videoCodec: String(chosen?.videoCodec ?? ""),
        videoProfile: String(chosen?.videoProfile ?? ""),
        audioCodec: String(chosen?.audioCodec ?? ""),
        audioChannels: chosen?.audioChannels ?? "",
        resolution: chosen ? `${chosen.width ?? "?"}x${chosen.height ?? "?"}` : "",
        bitrate: chosen?.bitrate ?? null,
        versions: media.length,
        mediaId: chosen?.id ?? null,
      });
    }
  }
  if (args.streams) {
    console.log(`Reading the streams of ${rows.length} titles…`);
    await readStreams(rows);
  }

  const movies = rows.filter((r) => r.kind === "movie");
  const episodes = rows.filter((r) => r.kind === "episode");
  if (movies.length) printGroup("Movies", movies);
  if (episodes.length) printGroup("TV episodes", episodes);
  const all = printGroup("Everything", rows);

  // Bandwidth is what Direct Play costs: each viewer pulls the file's own bitrate.
  const candidates = rows.filter((r) => (r.verdict === "now" || r.verdict === "hevc") && r.bitrate);
  const buckets = [[0, 10_000, "≤10"], [10_000, 20_000, "10–20"], [20_000, 40_000, "20–40"], [40_000, Infinity, ">40"]];
  console.log(`\nBitrate of the Direct Play candidates (Mbps): ${buckets
    .map(([lo, hi, label]) => `${label}: ${candidates.filter((r) => r.bitrate > lo && r.bitrate <= hi).length}`)
    .join(" · ")}`);
  const rescued = rows.filter((r) => r.otherPlays).length;
  if (rescued) console.log(`${rescued} more title(s) have another version that would Direct Play now.`);
  const playable = all.now.count + all.hevc.count;
  console.log(`\nIn short: ${pct(all.now.count, rows.length)} could Direct Play today, ${pct(playable, rows.length)} if every viewer can decode HEVC.`);
  if (args.streams) printStreams(rows);

  await mkdir(path.dirname(CSV_PATH), { recursive: true });
  const cols = ["section", "kind", "ratingKey", "title", "verdict", "reason", "otherPlays", "container", "videoCodec",
    "videoProfile", "audioCodec", "audioChannels", "resolution", "bitrate", "versions",
    ...(args.streams ? ["hdr", "doviProfile", "colorTrc", "scanType", "pictureSubs", "anamorphic"] : [])];
  const esc = (v) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [cols.join(","), ...rows.map((r) => cols.map((c) => esc(c === "verdict" ? VERDICTS[r.verdict] : r[c])).join(","))].join("\n");
  await writeFile(CSV_PATH, csv + "\n");
  console.log(`Every title and its verdict: ${CSV_PATH}`);
}

main().catch((err) => {
  console.error(`\nFailed: ${String(err.stack ?? err.message).split(PLEX_TOKEN).join("<token>")}`);
  process.exit(1);
});
