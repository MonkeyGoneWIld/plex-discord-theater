/**
 * What a subtitle burned in by ffmpeg is drawn from, when it isn't a picture
 * stream of the film itself (plan.ts BurnKind):
 *
 * - a text one, by libass from a UTF-8 copy of its text in a folder of its own
 *   — the whole track as a read of it kept it (embedded-subtitles.ts), out of
 *   an mkv's index (mkv-subtitles.ts), or a sidecar's file — with the fonts an
 *   ASS track came with, taken out of the film under names of this module's
 *   own, never the names the file gives them;
 * - a picture one in a file beside the film (a .sup, a VobSub .idx), read as a
 *   second input, found on the mount (findSidecar).
 *
 * Plex doesn't say which file a sidecar is: only its codec, language and
 * flags. So the film's folder is looked through for files named after the
 * film with that codec's extension, and the one whose name says that language
 * and those flags is it — when exactly one does. Otherwise it is Plex's.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { directStreamCacheDir } from "../direct-stream.js";
import { decodeSubtitle } from "../embedded-subtitles.js";
import { ffmpegPath } from "./config.js";
import type { BurnKind, SourceStream } from "./plan.js";
import type { Probed } from "./probe.js";

/** Where a burned subtitle's text and fonts are made ready: one folder each.
 *  Under the stream cache, which a restart clears. */
const BURN_DIR = path.join(directStreamCacheDir(), "burn");

/** How long fonts get to come out of the film. */
const FONTS_TIMEOUT_MS = 60_000;

/** Each codec's sidecar extensions, as Plex and ffprobe name it. VobSub is
 *  read from its .idx, which names its .sub. */
const SIDECAR_EXTENSIONS: Record<string, string[]> = {
  srt: ["srt"], subrip: ["srt"], ass: ["ass"], ssa: ["ssa", "ass"], vtt: ["vtt"], webvtt: ["vtt"], smi: ["smi"],
  vobsub: ["idx"], dvd_subtitle: ["idx"], pgs: ["sup"], hdmv_pgs_subtitle: ["sup"],
};

/** Words in a sidecar's name for its flags. */
const FORCED = new Set(["forced", "foreign"]);
const SDH = new Set(["sdh", "cc", "hi"]);

/** The names a language goes by in a file name, from what Plex says of it. */
function languageNames(sub: SourceStream): string[] {
  const names = [sub.languageTag, sub.languageCode, sub.language]
    .filter((n): n is string => !!n)
    .map((n) => n.toLowerCase());
  // Bibliographic codes some names carry for Plex's terminological ones.
  const BIBLIOGRAPHIC: Record<string, string> = {
    deu: "ger", fra: "fre", zho: "chi", nld: "dut", ell: "gre", fas: "per", ces: "cze", ron: "rum", slk: "slo",
  };
  for (const n of [...names]) if (BIBLIOGRAPHIC[n]) names.push(BIBLIOGRAPHIC[n]);
  // "en-US" in Plex's tag: "en" too.
  for (const n of [...names]) if (n.includes("-")) names.push(n.split("-")[0]);
  return [...new Set(names)];
}

/**
 * The file on the mount a sidecar Plex lists is, or null when that can't be
 * told for certain: in the film's folder, named after the film, with the
 * codec's extension, its language and flags in its name — or nothing in its
 * name but the film's, when no other file says the language.
 */
export function findSidecar(
  film: string, sub: SourceStream, list: (dir: string) => string[] = (dir) => fs.readdirSync(dir),
): string | null {
  const dir = path.dirname(film);
  const base = path.basename(film, path.extname(film)).toLowerCase();
  const extensions = SIDECAR_EXTENSIONS[(sub.codec ?? "").toLowerCase()] ?? [(sub.codec ?? "").toLowerCase()];
  let names: string[];
  try {
    names = list(dir);
  } catch {
    return null;
  }
  const candidates = names.flatMap((name) => {
    const lower = name.toLowerCase();
    const ext = path.extname(lower).slice(1);
    if (!extensions.includes(ext) || !lower.startsWith(`${base}.`)) return [];
    const middle = lower.slice(base.length + 1, lower.length - ext.length - 1);
    const tokens = middle.split(/[.\-_ ]+/).filter(Boolean);
    return [{ name, tokens }];
  });
  const flagsMatch = candidates.filter(({ tokens }) =>
    !!sub.forced === tokens.some((t) => FORCED.has(t)) && !!sub.hearingImpaired === tokens.some((t) => SDH.has(t)));
  const languages = languageNames(sub);
  const sayIt = flagsMatch.filter(({ tokens }) => tokens.some((t) => languages.includes(t)));
  if (sayIt.length === 1) return path.join(dir, sayIt[0].name);
  if (sayIt.length > 1) return null;
  const plain = flagsMatch.filter(({ tokens }) => tokens.every((t) => FORCED.has(t) || SDH.has(t)));
  return plain.length === 1 ? path.join(dir, plain[0].name) : null;
}

/** A sidecar's bytes off the mount, or null when it isn't found there. */
export function sidecarOnMount(film: string | null, sub: SourceStream): { file: string; bytes: Buffer } | null {
  if (!film) return null;
  const file = findSidecar(film, sub);
  if (!file) return null;
  try {
    return { file, bytes: fs.readFileSync(file) };
  } catch {
    return null;
  }
}

/** A subtitle's text format, by what it opens with. */
function textExtension(text: string): string {
  const head = text.replace(/^﻿/, "").trimStart().slice(0, 64).toLowerCase();
  if (head.startsWith("[script info]")) return "ass";
  if (head.startsWith("webvtt")) return "vtt";
  return "srt";
}

/** Whether an attachment is a font, as its mimetype or name says. */
function isFont(s: { mimetype: string | null; filename: string | null; codecName: string | null }): boolean {
  const mime = (s.mimetype ?? "").toLowerCase();
  if (/font|truetype|opentype|sfnt/.test(mime)) return true;
  if (["ttf", "otf"].includes((s.codecName ?? "").toLowerCase())) return true;
  return /\.(ttf|otf|ttc)$/i.test(s.filename ?? "");
}

/** The film's font attachments, in the order dumpFonts numbers them. */
export function fontAttachments(probed: Probed): Probed["streams"] {
  return probed.streams.filter((s) => s.codecType === "attachment" && isFont(s));
}

/** The film's fonts, written into `dir` as 0.ttf, 1.otf…; how many came. */
export function dumpFonts(input: string[], probed: Probed, dir: string): Promise<number> {
  const fonts = fontAttachments(probed);
  if (!fonts.length) return Promise.resolve(0);
  fs.mkdirSync(dir, { recursive: true });
  const dumps = fonts.flatMap((s, i) => {
    const ext = /\.otf$/i.test(s.filename ?? "") || /opentype/i.test(s.mimetype ?? "") ? "otf"
      : /\.ttc$/i.test(s.filename ?? "") ? "ttc" : "ttf";
    return [`-dump_attachment:${s.index}`, path.join(dir, `${i}.${ext}`)];
  });
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(ffmpegPath(), ["-hide_banner", "-nostdin", "-v", "error", "-y", ...dumps, ...input, "-t", "0", "-f", "null", "-"],
        { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      resolve(0);
      return;
    }
    const timer = setTimeout(() => child.kill("SIGKILL"), FONTS_TIMEOUT_MS);
    const done = () => {
      clearTimeout(timer);
      try {
        resolve(fs.readdirSync(dir).length);
      } catch {
        resolve(0);
      }
    };
    child.on("error", done);
    child.on("close", done);
  });
}

export interface BurnSource {
  sub: SourceStream;
  kind: Exclude<BurnKind, "picture">;
  /** The film on the mount, when it is there. */
  film: string | null;
  /** ffmpeg's input for the film, mount or Plex: for its fonts. */
  input: string[];
  /** ffprobe's streams of the film (probe.ts), for its fonts. */
  probed: Probed | null;
  /** The whole track as a read of it kept it, when it has been read. */
  storedText: () => string | null;
  /** The whole track out of an mkv's index, when that can be read. */
  indexText: () => Promise<string | null>;
  /** A sidecar's bytes through Plex. */
  sidecarBytes: () => Promise<Buffer | null>;
  /** A sidecar's own first timestamp, seconds (probe.ts startS). */
  startOf: (file: string) => Promise<number | null>;
}

export type BurnFiles =
  | { ok: true; file: string; fonts: string | null; fileStartS: number | null; from: string }
  | { ok: false; why: string };

/** Made ready already, per subtitle: one stream's seek is another start. */
const made = new Map<string, Promise<BurnFiles>>();

/** What ffmpeg draws a subtitle from, made ready once per subtitle and file. */
export function prepareBurn(key: string, o: BurnSource): Promise<BurnFiles> {
  let hit = made.get(key);
  if (!hit) {
    hit = prepare(key, o).then((r) => {
      // What failed is tried again next time: a read may have finished since.
      if (!r.ok) made.delete(key);
      return r;
    });
    made.set(key, hit);
  }
  return hit;
}

async function prepare(key: string, o: BurnSource): Promise<BurnFiles> {
  if (o.kind === "picture-sidecar") {
    const file = o.film ? findSidecar(o.film, o.sub) : null;
    if (!file) return { ok: false, why: "a picture subtitle beside the film, not found on the mount" };
    return { ok: true, file, fonts: null, fileStartS: await o.startOf(file), from: "mount" };
  }
  let text: string | null = null;
  let from = "";
  if (o.sub.key) {
    const onMount = sidecarOnMount(o.film, o.sub);
    const bytes = onMount?.bytes ?? await o.sidecarBytes().catch(() => null);
    if (bytes) [text, from] = [decodeSubtitle(bytes), onMount ? "mount" : "plex"];
  } else {
    text = o.storedText();
    from = "kept";
    if (!text) [text, from] = [await o.indexText().catch(() => null), "index"];
  }
  if (!text?.trim()) return { ok: false, why: "the subtitle's text isn't read out yet" };
  const dir = path.join(BURN_DIR, key.replace(/[^\w.-]+/g, "_"));
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `subtitle.${textExtension(text)}`);
  fs.writeFileSync(file, text.replace(/^﻿/, ""), "utf8");
  // An ASS track's fonts; SRT is drawn in the image's own.
  const fontsDir = path.join(dir, "fonts");
  const fonts = textExtension(text) === "ass" && !o.sub.key && o.probed
    ? await dumpFonts(o.input, o.probed, fontsDir)
    : 0;
  return { ok: true, file, fonts: fonts > 0 ? fontsDir : null, fileStartS: null, from };
}

/** For tests: forget what was made ready. */
export function forgetBurns(): void {
  made.clear();
}
