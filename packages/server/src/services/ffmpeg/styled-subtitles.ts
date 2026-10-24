/**
 * ASS subtitles drawn as their script has them — its fonts, colours,
 * positions, moves, fades, karaoke and drawings — by libass in the player
 * (StyledSubtitleLayer, with JASSUB), where services/subtitles.ts makes plain
 * lines of them, drawn in the viewer's own look. Only for a typeset track
 * (styledAss): a dub's signs and songs, or a fansub's own look. Your Lie in
 * April's signs-and-songs track is almost all of it, nearly 7,000 lines of
 * moves, fades and drawings in five fonts of its own, and as plain lines it
 * lost all of that.
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
 * Whether an ASS script has directions of its own for how its lines look —
 * enough of its lines placed, moved, faded, coloured or set in a font of their
 * own — so that it is drawn as it is, rather than as plain lines in the
 * viewer's look.
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
}
