/**
 * Reading a sidecar subtitle file into cues the client can draw.
 *
 * Why this exists: everything this server streams is transcoded, and Plex burns
 * subtitles into the picture while it does. Burned subtitles are pixels by the
 * time anyone sees them, so they cannot be timed against the audio afterwards —
 * which is the whole of what "subtitle offset" asks for. A sidecar file is the
 * one case where the text still exists as text, so it can be handed to the
 * client and drawn there, where shifting it is arithmetic rather than a
 * re-encode.
 *
 * Three input formats, because those are what sidecars come as. Anything else
 * is refused rather than guessed at: a subtitle rendered from a misparse is
 * worse than one that admits it could not be read.
 */

/** A cue, in seconds — the units video.currentTime is in. */
export interface Cue {
  start: number;
  end: number;
  text: string;
  /**
   * Drawn at the top of the picture rather than the bottom. An ASS line aligned
   * or positioned up there — a sign, a song title, a note — or an SRT/VTT cue
   * that asks for it. Absent for the ordinary case, so a cue list stays small.
   */
  top?: true;
  /** The whole line is in italics: a thought, a voice off screen, a flashback. */
  italic?: true;
}

/**
 * Bumped whenever the same file would now come out as different cues, so cues
 * kept from an older parse are read again rather than served as they were —
 * see embedded-subtitles.ts, which stores them.
 *
 * 2: ASS vector drawings dropped instead of drawn as their coordinates, signs
 *    animated frame by frame folded into one cue, alignment and italics kept.
 */
export const SUBTITLE_PARSER_VERSION = 2;

/** What a sidecar turned out to be. */
export type SubtitleFormat = "vtt" | "srt" | "ass";

/**
 * Which of the three this is, judged from the content rather than the filename.
 *
 * Plex's `format` field is usually right, but a file named .srt that opens with
 * "[Script Info]" is an ASS file whatever anyone called it, and the content is
 * the only thing that cannot be wrong about itself.
 */
export function sniffFormat(body: string): SubtitleFormat | null {
  const head = body.slice(0, 4096);
  if (/^\s*WEBVTT/.test(head)) return "vtt";
  if (
    /^\s*\[Script Info\]/im.test(head) ||
    /^\s*\[V4\+? Styles\]/im.test(head) ||
    // A file that has been cut down to its events is still an ASS file,
    // and "Dialogue:" belongs to no other subtitle format.
    /^\s*\[Events\]/im.test(head) ||
    /^\s*Dialogue\s*:/im.test(head)
  ) {
    return "ass";
  }
  // An SRT cue is a timecode line with a comma before the milliseconds. The
  // index line above it is optional in practice — plenty of files omit it.
  if (/\d{1,2}:\d{2}:\d{2},\d{1,3}\s*-->/.test(head)) return "srt";
  // A VTT missing its header is still a VTT if it times cues the VTT way.
  if (/\d{1,2}:\d{2}:\d{2}\.\d{1,3}\s*-->/.test(head)) return "vtt";
  return null;
}

/** "01:23:45,678", "01:23:45.678" or ASS's "1:23:45.67" → seconds. */
function parseTimestamp(raw: string): number | null {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(raw.trim());
  if (!m) return null;
  const [, h, mm, ss, frac] = m;
  // ASS writes centiseconds, SRT and VTT milliseconds. Padding right makes "50"
  // mean 500ms in a two-digit file and 50ms in a three-digit one, which is what
  // each format means by it.
  const ms = Number(frac.padEnd(3, "0"));
  return Number(h ?? 0) * 3600 + Number(mm) * 60 + Number(ss) + ms / 1000;
}

/** Normalise line endings and strip the byte-order mark some editors leave. */
function normalise(body: string): string {
  return body.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
}

/**
 * The tags an SRT or VTT cue may carry, and which this renderer does not draw.
 *
 * Named rather than matched as "anything in angle brackets", because subtitle
 * text does occasionally contain them for real — an SDH track writing
 * <inaudible>, or dialogue quoting a filename. Those survive; the formatting
 * that a player is expected to interpret does not.
 *
 * The list is what turns up in sidecar files: HTML inline formatting, <font>
 * with its colour and face attributes, VTT's own <c.classname> spans and <v
 * Speaker> voices, and ruby annotations from subtitles that carry furigana.
 */
const INLINE_TAG =
  // The class run is VTT's own syntax, which hangs off the tag name with no
  // space in between: <c.yellow.bg_blue>, <v.loud Roger>.
  /<\/?(?:i|b|u|s|em|strong|font|ruby|rt|rp|c|v|lang|span)(?:\.[^\s.>]+)*(?:[ \t][^>]*)?\/?>/gi;

/** VTT karaoke timestamps: <00:00:01.500> between words. */
const CUE_TIMESTAMP = /<\d{1,3}:\d{2}:\d{2}[.,]\d{1,3}>/g;

/** The handful of entities that turn up in files people actually have. */
const NAMED_ENTITY: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: "\u00a0",
};

/**
 * Strip a cue's inline markup down to the words.
 *
 * Sidecar SRTs regularly carry HTML: <i> for emphasis is near-universal, and
 * fansubbed and re-muxed files often wrap every line in <font color="#FFFFFF">.
 * The client draws cue text as text, so anything left here is shown to the
 * viewer verbatim — which is what put `<font color="#FFFFFF">` on screen around
 * the dialogue instead of colouring it.
 *
 * Colour and emphasis are dropped rather than honoured. Handing arbitrary
 * styling from a file straight into the page is not something to do casually,
 * and a subtitle that is legible over every frame of the film is worth more
 * than one that matches what a fansubber picked in 2009.
 */
function cleanCueText(raw: string): string {
  return raw
    // <br> is a break rather than a decoration, so it leaves one behind.
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(CUE_TIMESTAMP, "")
    .replace(INLINE_TAG, "")
    // ASS override blocks turn up in SRT files too — {\an8} on a sign, most
    // often. Only ones opening with a backslash: a bare {…} is more likely to
    // be something a character said.
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, body: string) => {
      if (body[0] === "#") {
        const code = body[1] === "x" || body[1] === "X"
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        // Anything outside Unicode, or a control character, is likelier to be
        // a false positive than an intended glyph — leave the text as it was.
        return Number.isFinite(code) && code >= 32 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : whole;
      }
      return NAMED_ENTITY[body.toLowerCase()] ?? whole;
    })
    // Stripping a tag can leave the space that sat beside it doubled up.
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .trim();
}

/** Whether every line of a raw SRT/VTT cue is wrapped in <i>…</i>. */
function allItalic(raw: string): boolean {
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return false;
  // One span across the whole cue, or one per line, which is how most
  // subtitlers write a two-line thought.
  const whole = /^<i>[\s\S]*<\/i>$/i.test(lines.join("\n")) && !/<\/i>[\s\S]*<i>/i.test(lines.join("\n"));
  return whole || lines.every((l) => /^<i>.*<\/i>$/i.test(l) && !/<\/i>.*<i>/i.test(l));
}

/**
 * Whether an SRT/VTT cue asks to sit at the top: an ASS {\an8} carried over
 * into an SRT (common on signs), or VTT's own `line:` setting placing it in
 * the upper half.
 */
function srtWantsTop(raw: string, settings: string): boolean {
  const an = /\{[^}]*\\an([1-9])[^}]*\}/.exec(raw);
  if (an) return Number(an[1]) >= 4;
  const line = /(?:^|\s)line:(-?\d+(?:\.\d+)?)(%?)/.exec(settings);
  if (!line) return false;
  const n = Number(line[1]);
  // A percentage is measured down the picture; a bare number counts lines,
  // from the top when positive and from the bottom when negative.
  return line[2] === "%" ? n < 50 : n >= 0;
}

/**
 * SRT, and VTT — which differ only in the separator before the milliseconds and
 * in whether cues carry a number above them.
 */
function parseSrtLike(body: string): Cue[] {
  const cues: Cue[] = [];
  for (const block of normalise(body).split(/\n{2,}/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0) continue;
    // The timing line, wherever it sits: a leading cue number is optional, and
    // a VTT cue may carry an identifier there instead.
    const at = lines.findIndex((l) => l.includes("-->"));
    if (at === -1) continue;
    const [rawStart, rawEnd] = lines[at].split("-->");
    if (rawEnd == null) continue;
    const start = parseTimestamp(rawStart);
    // Cue settings ("align:start position:50%") ride on the end timestamp.
    const [rawEndTime, ...settings] = rawEnd.trim().split(/\s+/);
    const end = parseTimestamp(rawEndTime);
    if (start == null || end == null) continue;
    const raw = lines.slice(at + 1).join("\n");
    const text = cleanCueText(raw);
    if (!text) continue;
    cues.push({
      start, end, text,
      ...(srtWantsTop(raw, settings.join(" ")) && { top: true as const }),
      ...(allItalic(raw) && { italic: true as const }),
    });
  }
  return cues;
}

/** Turn ASS's line breaks into real ones, once its override blocks are gone. */
function cleanAssText(raw: string): string {
  return cleanCueText(
    raw
      // Hard and soft breaks. Both become a newline: the distinction is about
      // whether a renderer may re-wrap, and ours does not.
      .replace(/\\[Nn]/g, "\n")
      // \h is a non-breaking space, not a break. It was being turned into a
      // newline with the other two, which split lines that were meant to hold
      // together — a name and a title, most often.
      .replace(/\\h/g, " "),
  );
}

/**
 * Whether an ASS alignment sits anywhere but the bottom row.
 *
 * ASS numbers alignments like a numeric keypad, 7–9 along the top. SSA, its
 * predecessor, counted 1–3 along the bottom, 5–7 along the top and 9–11 across
 * the middle — which is what a [V4 Styles] section and the old \a tag still
 * mean. The middle counts as the top here: it is where signs go, and it keeps
 * them off the dialogue.
 */
function alignedHigh(alignment: number, legacy: boolean): boolean {
  return legacy ? alignment >= 5 : alignment >= 4;
}

interface AssStyle {
  /** Not on the bottom row — see alignedHigh. */
  high: boolean;
  italic: boolean;
}

/** What one event's text came to, once its override blocks were read. */
interface AssLine {
  text: string;
  high: boolean | null;
  italic: boolean | null;
  /** \pos or \move: placed by coordinates rather than by alignment. */
  placed: boolean;
}

/**
 * Read an event's text, honouring the override blocks that change what is
 * shown and dropping the rest.
 *
 * The one that matters most is \p: from {\p1} until {\p0}, the "text" is a
 * vector drawing — "m 0 0 l 100 0 100 50 0 50" — which a typesetter uses for
 * masks, shapes and signs drawn by hand. Shown as text it is a screenful of
 * coordinates, which is what Your Lie in April's opening came out as.
 *
 * Alignment (\an, or SSA's \a), position (\pos, \move) and italics (\i) are
 * kept as the cue's placement and style; colour, fonts, rotation and the rest
 * this renderer does not draw, and they are dropped with their blocks.
 */
function readAssText(raw: string, playResY: number): AssLine {
  let drawing = false;
  let text = "";
  let high: boolean | null = null;
  let italic: boolean | null = null;
  let placed = false;
  for (const part of raw.split(/(\{[^}]*\})/)) {
    if (part.startsWith("{") && part.endsWith("}")) {
      // Each tag starts with a backslash; anything else in braces is a note
      // the typesetter left, and shows nothing.
      for (const [, name, arg] of part.matchAll(/\\(an|pos|move|a|p|i)(?![a-z])\(?([^\\)}]*)/gi)) {
        const tag = name.toLowerCase();
        const value = arg.trim();
        if (tag === "p") drawing = Number(value) > 0;
        else if (tag === "an" && /^[1-9]$/.test(value)) high = alignedHigh(Number(value), false);
        else if (tag === "a" && /^\d{1,2}$/.test(value)) high = alignedHigh(Number(value), true);
        else if (tag === "i" && /^[01]$/.test(value)) {
          // Only the style a line opens with says what the line is.
          if (text.trim() === "") italic = value === "1";
        } else if (tag === "pos" || tag === "move") {
          placed = true;
          const y = Number(value.split(",")[1]);
          if (Number.isFinite(y) && high === null) high = y < playResY / 2;
        }
      }
      continue;
    }
    if (!drawing) text += part;
  }
  return { text, high, italic, placed };
}

/** The visible characters of a line, for telling a sign from a fragment of one. */
function visibleLength(text: string): number {
  return [...text.replace(/[\s ]/g, "")].length;
}

/**
 * ASS/SSA.
 *
 * Every section the cues depend on is read: [Script Info] for the height the
 * script's coordinates are in, the styles for each one's alignment and italics,
 * and [Events] for the lines themselves. Field order is declared by each
 * section's own Format line rather than being fixed, so it is read from there —
 * files in the wild do vary. Text is always the last field and may itself
 * contain commas, which is why the split is limited to the number of declared
 * fields.
 *
 * Fansubbed anime is the hard case. Alongside the dialogue it carries
 * typesetting: signs translated in place, often redrawn every frame so they
 * follow the camera, and song lyrics animated a syllable at a time. Drawn as
 * plain text, that was a wall of flickering duplicates. So:
 *   - vector drawings are dropped (see readAssText);
 *   - a karaoke effect's generated lines — Effect "fx", one per syllable per
 *     frame — are dropped, and the plain lyric lines Aegisub keeps as comments
 *     beside them (Effect "karaoke") are shown instead, when the file has them;
 *   - a line placed by coordinates that is only a character or two is a piece
 *     of a sign or a syllable, and is dropped;
 *   - and repeats of one line, frame after frame or layer over layer, are
 *     folded into one cue by mergeRepeats.
 */
function parseAss(body: string): Cue[] {
  const cues: Cue[] = [];

  // Coordinates are in the script's own resolution, 288 lines tall when it
  // doesn't say (the spec's default).
  const resMatch = /^\s*PlayResY\s*:\s*(\d+)/im.exec(body);
  const playResY = resMatch && Number(resMatch[1]) > 0 ? Number(resMatch[1]) : 288;

  // A karaoke effect's lines are only dropped where its source lyrics are there
  // to show instead.
  const hasLyrics = /^\s*Comment\s*:.*,\s*karaoke\s*,/im.test(body);

  const styles = new Map<string, AssStyle>();
  let section = "";
  let fields: string[] | null = null;

  // Limit the split so commas inside the text survive: everything from the last
  // field onwards is one value.
  const split = (trimmed: string, count: number): string[] => {
    const parts = trimmed.slice(trimmed.indexOf(":") + 1).split(",");
    const values = parts.slice(0, count - 1).map((v) => v.trim());
    values.push(parts.slice(count - 1).join(","));
    return values;
  };

  for (const line of normalise(body).split("\n")) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      section = trimmed.toLowerCase();
      fields = null;
      continue;
    }
    const inStyles = section === "[v4+ styles]" || section === "[v4 styles]";
    if (!inStyles && section !== "[events]") continue;

    if (/^Format\s*:/i.test(trimmed)) {
      fields = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!fields) continue;

    if (inStyles) {
      if (!/^Style\s*:/i.test(trimmed)) continue;
      const values = split(trimmed, fields.length);
      const name = values[fields.indexOf("name")]?.trim();
      if (!name) continue;
      const alignment = Number(values[fields.indexOf("alignment")]);
      const italic = Number(values[fields.indexOf("italic")]);
      styles.set(name.replace(/^\*/, ""), {
        high: Number.isFinite(alignment) && alignedHigh(alignment, section === "[v4 styles]"),
        // ASS writes true as -1; some tools write 1.
        italic: Number.isFinite(italic) && italic !== 0,
      });
      continue;
    }

    const isDialogue = /^Dialogue\s*:/i.test(trimmed);
    const isComment = /^Comment\s*:/i.test(trimmed);
    if (!isDialogue && !isComment) continue;

    const iStart = fields.indexOf("start");
    const iEnd = fields.indexOf("end");
    const iText = fields.indexOf("text");
    if (iStart === -1 || iEnd === -1 || iText === -1) continue;

    const values = split(trimmed, fields.length);
    const effect = (values[fields.indexOf("effect")] ?? "").trim().toLowerCase();
    if (isComment && !(hasLyrics && effect === "karaoke")) continue;
    if (isDialogue && hasLyrics && effect === "fx") continue;

    const start = parseTimestamp(values[iStart] ?? "");
    const end = parseTimestamp(values[iEnd] ?? "");
    if (start == null || end == null) continue;

    const style = styles.get((values[fields.indexOf("style")] ?? "").trim().replace(/^\*/, ""));
    const read = readAssText(values[iText] ?? "", playResY);
    const text = cleanAssText(read.text);
    if (!text) continue;
    if (read.placed && visibleLength(text) <= 2) continue;

    cues.push({
      start, end, text,
      ...((read.high ?? style?.high ?? false) && { top: true as const }),
      ...((read.italic ?? style?.italic ?? false) && { italic: true as const }),
    });
  }
  return cues;
}

/**
 * Fold repeats of one line into a single cue.
 *
 * A sign that tracks the camera is the same words re-timed every frame, 24
 * lines a second; a sign with an outline is the same words on two layers at
 * once. Each is one thing on screen, and drawn here as one — the same text, in
 * the same place, running on (with a frame's grace) from where the last copy
 * ended.
 */
function mergeRepeats(cues: Cue[]): Cue[] {
  const GRACE_S = 0.1;
  const open = new Map<string, Cue>();
  const out: Cue[] = [];
  const sorted = [...cues].sort((a, b) => a.start - b.start || a.end - b.end);
  for (const cue of sorted) {
    const key = `${cue.top ? 1 : 0}${cue.italic ? 1 : 0}${cue.text}`;
    const last = open.get(key);
    if (last && cue.start <= last.end + GRACE_S) {
      if (cue.end > last.end) last.end = cue.end;
      continue;
    }
    const copy = { ...cue };
    open.set(key, copy);
    out.push(copy);
  }
  return out;
}

/**
 * A sidecar's cues, or null when the file is not one of the three text formats.
 *
 * Cues come out in time order whatever order the file listed them in — ASS
 * files in particular are not always sorted, and a renderer that walked the
 * list in file order would skip the ones that arrived out of turn.
 */
export function parseSubtitles(
  body: string,
): { format: SubtitleFormat; cues: Cue[] } | null {
  const format = sniffFormat(body);
  if (!format) return null;
  const cues = mergeRepeats(format === "ass" ? parseAss(body) : parseSrtLike(body));
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return { format, cues };
}
