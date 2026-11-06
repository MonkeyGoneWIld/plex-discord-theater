/**
 * ASS subtitles drawn as their script has them — its fonts, colours,
 * positions, moves, fades, karaoke and drawings — by libass in the player
 * (StyledSubtitleLayer, with JASSUB), where services/subtitles.ts makes plain
 * lines of them, drawn in the viewer's own look. Every one, as Plex draws
 * them. Your Lie in April's signs-and-songs track is nearly 7,000 lines of
 * moves, fades and drawings in five fonts of its own, and as plain lines it
 * lost all of that. It was only typeset ones at first (styledAss), and one
 * with a look of its own and few tags, a fansub's colours and font, still
 * lost it: whatever a script sets is what Plex shows.
 *
 * Its fonts are the film's attachments, taken out once and kept by what they
 * are — a hash of their bytes — so a series' episodes share them, and so does
 * the browser, which keeps each for good.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dumpFonts, fontAttachments } from "./burn-files.js";
import type { Probed } from "./probe.js";

/**
 * Override tags that place, move, turn, animate, colour or re-font a line, or
 * draw a shape: what plain dialogue doesn't have. Not \an (a line at the top,
 * which the plain lines keep), \i, \b, \u or \s.
 */
const TYPESET_TAG = new RegExp([
  String.raw`\\(?:pos|move|org|t|fade?|i?clip)\(`,
  String.raw`\\(?:kf|ko|k|K)\d`,
  String.raw`\\p[1-9]`,
  String.raw`\\fr[xyz]?-?[\d.]`,
  String.raw`\\fsc[xy]?[\d.]`,
  String.raw`\\fa[xy]-?[\d.]`,
  String.raw`\\fsp-?[\d.]`,
  String.raw`\\fs[\d.]`,
  String.raw`\\fn[^\\}]`,
  String.raw`\\(?:blur|be)[\d.]`,
  String.raw`\\[xy]?(?:bord|shad)-?[\d.]`,
  String.raw`\\[1-4]?c&`,
  String.raw`\\(?:[1-4]a|alpha)&`,
  String.raw`\\q\d`,
].join("|"));
/** A script is typeset when this share of its lines are, and at least TYPESET_MIN. */
const TYPESET_SHARE = 0.02;
const TYPESET_MIN = 3;

/**
 * Whether an ASS script is typeset — enough of its lines placed, moved,
 * faded, coloured or set in a font of their own — for the log.
 */
export function styledAss(script: string): boolean {
  let lines = 0;
  let typeset = 0;
  for (const line of script.split(/\r?\n/)) {
    if (!line.startsWith("Dialogue:")) continue;
    lines++;
    // The text follows the ninth comma: Layer, Start, End, Style, Name,
    // MarginL, MarginR, MarginV, Effect. Its tags are in braces.
    let at = 0;
    for (let i = 0; i < 9 && at !== -1; i++) at = line.indexOf(",", at + 1);
    if (at === -1) continue;
    for (const block of line.slice(at + 1).matchAll(/\{([^}]*)\}/g)) {
      if (TYPESET_TAG.test(block[1])) {
        typeset++;
        break;
      }
    }
  }
  return typeset >= TYPESET_MIN && typeset >= lines * TYPESET_SHARE;
}

export interface SubtitleFont {
  /** What it is kept as: the hash of its bytes, and its kind. */
  id: string;
  /** What the film calls it. */
  name: string;
  bytes: number;
}

const FONT_ID = /^[0-9a-f]{40}\.(ttf|otf|ttc)$/;

function fontsDir(): string {
  const data = process.env.THUMB_CACHE_DIR
    ? path.resolve(process.env.THUMB_CACHE_DIR)
    : path.resolve(import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname), "../../../data");
  return path.join(data, "subtitle-fonts");
}

/** Each film's fonts, by its fingerprint: taken out once while the server runs,
 *  and listed on disk for after. */
const filmFonts = new Map<string, Promise<SubtitleFont[]>>();

/**
 * A film's fonts — its font attachments, as probed — taken out of it through
 * `input` the first time they are asked for. None when it has none, or they
 * couldn't be had.
 */
export function fontsOfFilm(fingerprint: string, input: string[], probed: Probed | null): Promise<SubtitleFont[]> {
  let got = filmFonts.get(fingerprint);
  if (!got) {
    got = takeFonts(fingerprint, input, probed).catch(() => []);
    filmFonts.set(fingerprint, got);
  }
  return got;
}

async function takeFonts(fingerprint: string, input: string[], probed: Probed | null): Promise<SubtitleFont[]> {
  const dir = fontsDir();
  const listFile = path.join(dir, "films", `${createHash("sha1").update(fingerprint).digest("hex")}.json`);
  try {
    const listed = JSON.parse(fs.readFileSync(listFile, "utf8")) as SubtitleFont[];
    if (listed.every((f) => fontFile(f.id))) return listed;
  } catch {
    // Not taken out yet.
  }
  if (!probed) return [];
  const attached = fontAttachments(probed);
  const fonts: SubtitleFont[] = [];
  if (attached.length) {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = fs.mkdtempSync(path.join(dir, "taking-"));
    try {
      await dumpFonts(input, probed, tmp);
      for (const [i, s] of attached.entries()) {
        const file = fs.readdirSync(tmp).find((f) => f.startsWith(`${i}.`));
        if (!file) continue;
        const bytes = fs.readFileSync(path.join(tmp, file));
        if (bytes.length === 0) continue;
        const id = `${createHash("sha1").update(bytes).digest("hex")}${path.extname(file)}`;
        const kept = path.join(dir, id);
        if (!fs.existsSync(kept)) fs.renameSync(path.join(tmp, file), kept);
        if (!fonts.some((f) => f.id === id)) fonts.push({ id, name: s.filename ?? file, bytes: bytes.length });
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  }
  fs.mkdirSync(path.dirname(listFile), { recursive: true });
  fs.writeFileSync(listFile, JSON.stringify(fonts));
  return fonts;
}

/** Where a kept font is, by its id; null for one that isn't. */
export function fontFile(id: string): string | null {
  if (!FONT_ID.test(id)) return null;
  const file = path.join(fontsDir(), id);
  return fs.existsSync(file) ? file : null;
}

/** For tests: forget which films' fonts were taken out. */
export function forgetFilmFonts(): void {
  filmFonts.clear();
  namesById.clear();
}

/**
 * The names a font answers to, lower-cased, as libass matches a script's font
 * names to them: each face's family, full and PostScript names (and its
 * typographic family), every face of a collection. Empty for one that can't
 * be read.
 */
export function fontNames(data: Uint8Array): string[] {
  const names = new Set<string>();
  const u16 = (at: number) => (data[at] << 8) | data[at + 1];
  const u32 = (at: number) => ((data[at] << 24) >>> 0) + (data[at + 1] << 16) + (data[at + 2] << 8) + data[at + 3];
  const tag = (at: number) => String.fromCharCode(data[at], data[at + 1], data[at + 2], data[at + 3]);
  const face = (at: number) => {
    if (at + 12 > data.length) return;
    const tables = u16(at + 4);
    for (let i = 0; i < tables; i++) {
      const rec = at + 12 + i * 16;
      if (rec + 16 > data.length) return;
      if (tag(rec) !== "name") continue;
      const table = u32(rec + 8);
      if (table + 6 > data.length) return;
      const strings = table + u16(table + 4);
      for (let j = 0, count = u16(table + 2); j < count; j++) {
        const r = table + 6 + j * 12;
        if (r + 12 > data.length) return;
        const [platform, encoding, id, length] = [u16(r), u16(r + 2), u16(r + 6), u16(r + 8)];
        const from = strings + u16(r + 10);
        if (![1, 4, 6, 16].includes(id) || from + length > data.length) continue;
        let text = "";
        // UTF-16 (Unicode, and Windows' Symbol, BMP and full); Mac Roman. Not
        // the Windows ones in Shift JIS and the like.
        if (platform === 0 || (platform === 3 && (encoding === 0 || encoding === 1 || encoding === 10))) {
          for (let k = from; k + 1 < from + length; k += 2) text += String.fromCharCode(u16(k));
        } else if (platform === 1 && encoding === 0) {
          text = Buffer.from(data.subarray(from, from + length)).toString("latin1");
        }
        const name = text.replace(/\0/g, "").trim().toLowerCase();
        if (name) names.add(name);
      }
      return;
    }
  };
  if (data.length >= 12 && tag(0) === "ttcf") {
    for (let i = 0, n = Math.min(u32(8), 64); i < n; i++) face(u32(12 + i * 4));
  } else {
    face(0);
  }
  return [...names];
}

/** Each kept font's names, by its id: the file never changes. */
const namesById = new Map<string, string[]>();

/** The names a kept font answers to (fontNames); empty when it can't be read. */
export function keptFontNames(id: string): string[] {
  let names = namesById.get(id);
  if (!names) {
    const file = fontFile(id);
    try {
      names = file ? fontNames(fs.readFileSync(file)) : [];
    } catch {
      names = [];
    }
    namesById.set(id, names);
  }
  return names;
}

/** A font's lines this close together, seconds, are one stretch of its use. */
const USE_GAP_S = 30;

/** "0:01:02.50" as seconds; NaN for anything else. */
function assTime(t: string): number {
  const m = /^\s*(\d+):(\d{1,2}):(\d{1,2}(?:\.\d+)?)\s*$/.exec(t);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : NaN;
}

/**
 * When in the film each of `fonts` is drawn with: the stretches, seconds, of
 * the script's lines set in it — by their style's font, or a \fn or \r of
 * theirs — lines within USE_GAP_S of each other as one. Those its lines never
 * use have none. A font whose names couldn't be read is left out: there is no
 * telling, and the player takes it as wanted at once.
 *
 * So a player fetches the fonts its picture's next minute is drawn in beside
 * the picture, and the rest as it has picture to spare (StyledSubtitleLayer):
 * on 6 November Steins;Gate's 29 fonts, 16.4 MB, came in beside its first two
 * segments, and its starts took 16 and 18 s.
 */
export function fontUses(
  script: string,
  fonts: ReadonlyArray<{ id: string; names: readonly string[] }>,
): Map<string, Array<[number, number]>> {
  const norm = (n: string) => n.trim().replace(/^@/, "").toLowerCase();
  const byName = new Map<string, string[]>();
  for (const f of fonts) for (const n of f.names) byName.set(n, [...(byName.get(n) ?? []), f.id]);
  const stretches = new Map<string, Array<[number, number]>>();
  for (const f of fonts) if (f.names.length) stretches.set(f.id, []);

  let section = "";
  let styleFormat = ["name", "fontname"];
  let eventFormat = ["layer", "start", "end", "style", "name", "marginl", "marginr", "marginv", "effect", "text"];
  const styleFont = new Map<string, string>();
  // As libass looks a style up: by its name, a leading * dropped, else Default.
  const fontOfStyle = (name: string) => {
    const n = name.trim().replace(/^\*/, "");
    return styleFont.get(n) ?? styleFont.get(n.toLowerCase()) ?? styleFont.get("Default") ?? styleFont.get("default");
  };
  for (const raw of script.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      section = line.toLowerCase();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1);
    if (section.includes("styles")) {
      if (key === "format") {
        styleFormat = value.split(",").map((f) => f.trim().toLowerCase());
      } else if (key === "style") {
        const fields = value.split(",");
        const name = fields[styleFormat.indexOf("name")]?.trim().replace(/^\*/, "");
        const font = fields[styleFormat.indexOf("fontname")];
        if (name === undefined || font === undefined) continue;
        styleFont.set(name, norm(font));
        if (!styleFont.has(name.toLowerCase())) styleFont.set(name.toLowerCase(), norm(font));
      }
    } else if (section === "[events]") {
      if (key === "format") {
        eventFormat = value.split(",").map((f) => f.trim().toLowerCase());
        continue;
      }
      if (key !== "dialogue") continue;
      // The text is the last field, commas and all.
      const fields: string[] = [];
      let at = 0;
      for (let i = 0; i < eventFormat.length - 1; i++) {
        const comma = value.indexOf(",", at);
        if (comma < 0) break;
        fields.push(value.slice(at, comma));
        at = comma + 1;
      }
      const text = value.slice(at);
      const start = assTime(fields[eventFormat.indexOf("start")] ?? "");
      const end = assTime(fields[eventFormat.indexOf("end")] ?? "");
      if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
      const wanted = new Set<string>();
      const own = fontOfStyle(fields[eventFormat.indexOf("style")] ?? "Default");
      if (own) wanted.add(own);
      for (const block of text.matchAll(/\{([^}]*)\}/g)) {
        for (const t of block[1].matchAll(/\\(fn|r)([^\\}]*)/g)) {
          const arg = t[2].trim();
          if (!arg) continue;
          const font = t[1] === "fn" ? norm(arg) : fontOfStyle(arg);
          if (font) wanted.add(font);
        }
      }
      for (const name of wanted) {
        for (const id of byName.get(name) ?? []) stretches.get(id)?.push([start, Math.max(start, end)]);
      }
    }
  }
  for (const [id, uses] of stretches) {
    uses.sort((a, b) => a[0] - b[0]);
    const merged: Array<[number, number]> = [];
    for (const [s, e] of uses) {
      const last = merged[merged.length - 1];
      if (last && s - last[1] <= USE_GAP_S) last[1] = Math.max(last[1], e);
      else merged.push([s, e]);
    }
    stretches.set(id, merged.map(([s, e]) => [Math.floor(s * 10) / 10, Math.ceil(e * 10) / 10]));
  }
  return stretches;
}
