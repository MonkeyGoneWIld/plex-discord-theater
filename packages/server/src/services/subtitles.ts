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
}

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
    const end = parseTimestamp(rawEnd.trim().split(/\s+/)[0]);
    if (start == null || end == null) continue;
    const text = cleanCueText(lines.slice(at + 1).join("\n"));
    if (text) cues.push({ start, end, text });
  }
  return cues;
}

/** Strip ASS override blocks and turn its line breaks into real ones. */
function cleanAssText(raw: string): string {
  return cleanCueText(
    raw
      // {\an8}, {\i1}, {\pos(…)} — positioning and styling this renderer does
      // not implement. Dropping them leaves the words, which is the part that
      // matters.
      .replace(/\{[^}]*\}/g, "")
      // Hard and soft breaks. Both become a newline: the distinction is about
      // whether a renderer may re-wrap, and ours does not.
      .replace(/\\[Nn]/g, "\n")
      // \h is a non-breaking space, not a break. It was being turned into a
      // newline with the other two, which split lines that were meant to hold
      // together — a name and a title, most often.
      .replace(/\\h/g, "\u00a0"),
  );
}

/**
 * ASS/SSA.
 *
 * Only the [Events] section matters, and only its Start, End and Text fields.
 * The field order is declared by that section's own Format line rather than
 * being fixed, so it is read from there — files in the wild do vary. Text is
 * always the last field and may itself contain commas, which is why the split
 * is limited to the number of declared fields.
 */
function parseAss(body: string): Cue[] {
  const cues: Cue[] = [];
  let fields: string[] | null = null;
  let inEvents = false;

  for (const line of normalise(body).split("\n")) {
    const trimmed = line.trim();
    if (/^\[.*\]$/.test(trimmed)) {
      inEvents = /^\[events\]$/i.test(trimmed);
      fields = null;
      continue;
    }
    if (!inEvents) continue;

    if (/^Format\s*:/i.test(trimmed)) {
      fields = trimmed
        .slice(trimmed.indexOf(":") + 1)
        .split(",")
        .map((f) => f.trim().toLowerCase());
      continue;
    }
    if (!/^Dialogue\s*:/i.test(trimmed) || !fields) continue;

    const iStart = fields.indexOf("start");
    const iEnd = fields.indexOf("end");
    const iText = fields.indexOf("text");
    if (iStart === -1 || iEnd === -1 || iText === -1) continue;

    // Limit the split so commas inside the dialogue survive: everything from
    // the Text field onwards is one value.
    const parts = trimmed.slice(trimmed.indexOf(":") + 1).split(",");
    const values = parts.slice(0, fields.length - 1);
    values.push(parts.slice(fields.length - 1).join(","));

    const start = parseTimestamp(values[iStart] ?? "");
    const end = parseTimestamp(values[iEnd] ?? "");
    if (start == null || end == null) continue;
    const text = cleanAssText(values[iText] ?? "");
    if (text) cues.push({ start, end, text });
  }
  return cues;
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
  const cues = format === "ass" ? parseAss(body) : parseSrtLike(body);
  cues.sort((a, b) => a.start - b.start || a.end - b.end);
  return { format, cues };
}
