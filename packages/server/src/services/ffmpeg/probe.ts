/**
 * What ffprobe says a file has, against what Plex says it has.
 *
 * Every -map the engine writes is Plex's Stream.index: the place of a stream
 * among the file's own. Phase 0 found Plex's numbering and ffprobe's the same
 * on 20 files out of 20, but a file replaced on disk since Plex last read it,
 * or a container Plex numbers its own way, would have ffmpeg copy the
 * commentary track as the film's sound, or burn the wrong language in. So the
 * first stream of each file asks ffprobe for its streams once and checks the
 * ones a stream uses — their kind, codec and language — and a file that
 * doesn't match is left to Plex, which numbers its own way.
 */
import { spawn } from "node:child_process";
import { LruMap } from "../lru.js";
import { ffprobePath } from "./config.js";
import type { HdrMeta } from "./hdr-init.js";
import type { SourceStream } from "./plan.js";

export interface ProbedStream {
  index: number;
  codecType: string;
  codecName: string | null;
  language: string | null;
  filename: string | null;
  mimetype: string | null;
}

export interface Probed {
  streams: ProbedStream[];
  startS: number | null;
  /** How long the file is, as its container says; null when it doesn't. */
  durationS?: number | null;
}

/** How long ffprobe gets: a file's header, from the mount or through Plex. */
const PROBE_TIMEOUT_MS = 15_000;

/** ffprobe's answer for a file, null when it couldn't say. */
export function probe(input: string[]): Promise<Probed | null> {
  return new Promise((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(ffprobePath(), [
        "-hide_banner", "-v", "error",
        "-show_entries", "format=start_time,duration:stream=index,codec_type,codec_name:stream_tags=language,filename,mimetype",
        "-of", "json", ...input,
      ], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { resolve(null); return; }
      try {
        const json = JSON.parse(out) as {
          format?: { start_time?: string; duration?: string };
          streams?: Array<{ index: number; codec_type?: string; codec_name?: string; tags?: Record<string, string> }>;
        };
        const start = Number(json.format?.start_time);
        const duration = Number(json.format?.duration);
        resolve({
          startS: Number.isFinite(start) ? start : null,
          durationS: Number.isFinite(duration) && duration > 0 ? duration : null,
          streams: (json.streams ?? []).map((s) => ({
            index: s.index,
            codecType: s.codec_type ?? "",
            codecName: s.codec_name ?? null,
            language: s.tags?.language ?? s.tags?.LANGUAGE ?? null,
            filename: s.tags?.filename ?? null,
            mimetype: s.tags?.mimetype ?? null,
          })),
        });
      } catch {
        resolve(null);
      }
    });
  });
}

/** "a/b" or a plain number, as ffprobe writes side data. */
function ratio(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v !== "string") return null;
  const [a, b] = v.split("/").map(Number);
  const n = b === undefined ? a : a / b;
  return Number.isFinite(n) ? n : null;
}

/** HDR10 metadata from ffprobe's side data, as hdr-init.ts's boxes hold it. */
export function hdrMetaOf(sideData: Array<Record<string, unknown>>): HdrMeta | null {
  const md = sideData.find((s) => s.side_data_type === "Mastering display metadata");
  const cl = sideData.find((s) => s.side_data_type === "Content light level metadata");
  const xy = ["green_x", "green_y", "blue_x", "blue_y", "red_x", "red_y", "white_point_x", "white_point_y"]
    .map((k) => ratio(md?.[k]));
  const peak = ratio(md?.max_luminance);
  const least = ratio(md?.min_luminance);
  const mdcv = md && xy.every((v) => v !== null && v >= 0 && v <= 1) && peak !== null && peak > 0 && least !== null && least >= 0
    ? [...xy.map((v) => Math.round(v! * 50_000)), Math.round(peak * 10_000), Math.round(least * 10_000)]
    : null;
  const maxCll = ratio(cl?.max_content);
  const maxFall = ratio(cl?.max_average);
  const clli: [number, number] | null = cl && maxCll !== null && maxFall !== null && maxCll > 0 && maxCll <= 65_535 && maxFall >= 0 && maxFall <= 65_535
    ? [Math.round(maxCll), Math.round(maxFall)] : null;
  return mdcv || clli ? { mdcv, clli } : null;
}

const hdrChecked = new Map<string, Promise<HdrMeta | null>>();

/**
 * A file's HDR10 metadata — its stream's, else its first frame's SEI — once
 * per file and size: null when it has none or ffprobe couldn't say.
 */
export function probeHdrMeta(key: string, input: string[]): Promise<HdrMeta | null> {
  const hit = hdrChecked.get(key);
  if (hit) return hit;
  const asked = new Promise<HdrMeta | null>((resolve) => {
    let out = "";
    let child;
    try {
      child = spawn(ffprobePath(), [
        "-hide_banner", "-v", "error", "-select_streams", "v:0", "-read_intervals", "%+#1",
        "-show_entries", "stream=side_data_list:frame=side_data_list", "-show_frames",
        "-of", "json", ...input,
      ], { stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), PROBE_TIMEOUT_MS);
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.on("error", () => { clearTimeout(timer); resolve(null); });
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const json = JSON.parse(out) as {
          streams?: Array<{ side_data_list?: Array<Record<string, unknown>> }>;
          frames?: Array<{ side_data_list?: Array<Record<string, unknown>> }>;
        };
        resolve(hdrMetaOf([
          ...(json.streams?.[0]?.side_data_list ?? []),
          ...(json.frames ?? []).flatMap((f) => f.side_data_list ?? []),
        ]));
      } catch {
        resolve(null);
      }
    });
  });
  hdrChecked.set(key, asked);
  return asked;
}

const KINDS: Record<number, string> = { 1: "video", 2: "audio", 3: "subtitle" };

/** Plex's codec names that aren't ffprobe's. */
const PLEX_TO_FFPROBE: Record<string, string[]> = {
  dca: ["dts"], "dts-hd": ["dts"], pgs: ["hdmv_pgs_subtitle"], srt: ["subrip"], subrip: ["subrip"],
  vobsub: ["dvd_subtitle"], dvb_subtitle: ["dvb_subtitle"], ssa: ["ass", "ssa"], ass: ["ass", "ssa"],
  mpeg2video: ["mpeg2video"], mpeg1video: ["mpeg1video", "mpeg2video"], vc1: ["vc1"], wmv3: ["wmv3", "vc1"],
  msmpeg4v3: ["msmpeg4v3"], mpeg4: ["mpeg4"], mov_text: ["mov_text"], tx3g: ["mov_text"], webvtt: ["webvtt"],
  vtt: ["webvtt"],
};

/** Whether Plex's codec and ffprobe's are one: by name, alias, or one the
 *  other's family ("pcm" and "pcm_s24le"). A codec this doesn't know sends a
 *  title to Plex for nothing, so it leans to yes. */
function sameCodec(plex: string, file: string): boolean {
  if ((PLEX_TO_FFPROBE[plex] ?? [plex]).includes(file)) return true;
  return file.startsWith(plex) || plex.startsWith(file);
}

/** ISO 639-2's bibliographic names, which some files carry, for their
 *  terminological ones, which Plex gives. */
const LANGUAGE_ALIASES: Record<string, string> = {
  ger: "deu", fre: "fra", chi: "zho", dut: "nld", gre: "ell", per: "fas", cze: "ces", rum: "ron", slo: "slk",
  ice: "isl", mac: "mkd", may: "msa", alb: "sqi", arm: "hye", baq: "eus", bur: "mya", geo: "kat", tib: "bod", wel: "cym",
};
/** A language as ISO 639-2/T, or null for none, an undetermined one, or one
 *  written some other way ("en", "English"), which isn't compared. */
const lang = (code: string | null | undefined): string | null => {
  const c = (code ?? "").trim().toLowerCase();
  if (!/^[a-z]{3}$/.test(c) || c === "und" || c === "unk" || c === "mis" || c === "zxx" || c === "mul") return null;
  return LANGUAGE_ALIASES[c] ?? c;
};

/**
 * Whether the streams Plex numbers for this stream are what the file has at
 * those numbers: null when they are, else what isn't. Codecs and languages are
 * only held against each other when both sides name one.
 */
export function trackMismatch(used: SourceStream[], probed: Probed): string | null {
  for (const s of used) {
    if (s.index == null || s.key) continue;
    const kind = KINDS[s.streamType];
    const found = probed.streams.find((p) => p.index === s.index);
    if (!found) return `the file has no stream #${s.index} (Plex's ${kind} ${s.codec ?? ""})`.trim();
    if (kind && found.codecType !== kind) return `stream #${s.index} is ${found.codecType} in the file, ${kind} to Plex`;
    const plexCodec = (s.codec ?? "").toLowerCase();
    const fileCodec = (found.codecName ?? "").toLowerCase();
    if (plexCodec && fileCodec && !sameCodec(plexCodec, fileCodec)) {
      return `stream #${s.index} is ${fileCodec} in the file, ${plexCodec} to Plex`;
    }
    const plexLang = lang(s.languageCode);
    const fileLang = lang(found.language);
    if (plexLang && fileLang && plexLang !== fileLang) {
      return `stream #${s.index} is ${fileLang} in the file, ${plexLang} to Plex`;
    }
  }
  return null;
}

/** Each file's answer, by its path and size: a file replaced is asked again. */
const checked = new LruMap<string, Probed | "unprobed">(500);

/**
 * ffprobe's streams for a file, once per file and size: null when ffprobe
 * couldn't say (missing, timed out), which leaves the check undone rather
 * than the stream to Plex.
 */
export async function probeOnce(key: string, input: string[]): Promise<Probed | null> {
  const hit = checked.get(key);
  if (hit) return hit === "unprobed" ? null : hit;
  const probed = await probe(input);
  checked.set(key, probed ?? "unprobed");
  return probed;
}

/** For tests: forget every file's answer. */
export function forgetProbes(): void {
  checked.clear();
  hdrChecked.clear();
}
