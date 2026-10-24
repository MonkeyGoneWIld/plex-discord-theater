/**
 * A codec as the browser names it — "avc1.640028", "mp4a.40.2" — in the words
 * a person uses: "H.264 High@L4.0", "AAC-LC". For Stats for nerds.
 */

/** MPEG-4 audio object types, the last number of "mp4a.40.N". */
const AAC_OBJECTS: Record<string, string> = {
  "1": "AAC Main", "2": "AAC-LC", "3": "AAC SSR", "4": "AAC LTP", "5": "HE-AAC", "23": "AAC-LD",
  "29": "HE-AAC v2", "34": "MP3", "39": "AAC-ELD", "42": "xHE-AAC",
};
const AVC_PROFILES: Record<number, string> = {
  66: "Baseline", 77: "Main", 88: "Extended", 100: "High", 110: "High 10", 122: "High 4:2:2", 244: "High 4:4:4",
};
const HEVC_PROFILES: Record<number, string> = { 1: "Main", 2: "Main 10", 3: "Main Still", 4: "RExt" };
const AV1_PROFILES: Record<string, string> = { "0": "Main", "1": "High", "2": "Professional" };

/** "4.0" from 40, "4.1" from 41. */
const level = (n: number) => (Number.isFinite(n) && n > 0 ? `@L${Number.isInteger(n) ? n.toFixed(0) : String(n)}` : "");

/** The full name: codec, profile and level where the string says them. */
export function codecName(codec: string | null | undefined): string | null {
  if (!codec) return null;
  const [kind = "", ...parts] = codec.trim().split(".");
  switch (kind.toLowerCase()) {
    case "mp4a":
      if (parts[0] === "40") return AAC_OBJECTS[parts[1] ?? ""] ?? "AAC";
      if (parts[0]?.toLowerCase() === "69" || parts[0]?.toLowerCase() === "6b") return "MP3";
      if (parts[0]?.toLowerCase() === "a5") return "AC3";
      if (parts[0]?.toLowerCase() === "a6") return "EAC3";
      return "AAC";
    case "ac-3": return "AC3";
    case "ec-3": return "EAC3";
    case "opus": return "Opus";
    case "flac": return "FLAC";
    case "mp3": return "MP3";
    case "avc1":
    case "avc3": {
      const hex = parts[0] ?? "";
      if (!/^[0-9a-f]{6}$/i.test(hex)) return "H.264";
      const profile = AVC_PROFILES[parseInt(hex.slice(0, 2), 16)];
      const lvl = parseInt(hex.slice(4, 6), 16) / 10;
      return `H.264${profile ? ` ${profile}` : ""}${level(lvl).replace(/@L(\d+)$/, "@L$1.0")}`;
    }
    case "hvc1":
    case "hev1": {
      const idc = parseInt((parts[0] ?? "").replace(/^[A-C]/i, ""), 10);
      const tier = /^[LH](\d+)$/i.exec(parts[2] ?? "");
      const lvl = tier ? Math.round(Number(tier[1]) / 3) / 10 : NaN;
      return `HEVC${HEVC_PROFILES[idc] ? ` ${HEVC_PROFILES[idc]}` : ""}${level(lvl)}`;
    }
    case "av01": {
      const profile = AV1_PROFILES[parts[0] ?? ""];
      return `AV1${profile ? ` ${profile}` : ""}`;
    }
    case "vp09":
    case "vp9": return "VP9";
    default: return codec;
  }
}

/** A codec string that is sound, as hls.js and MSE name them. */
const AUDIO_CODEC = /^(mp4a|opus|flac|ac-3|ec-3|dts[cehlx]|mlpa|alac|mp3)/i;

/**
 * A stream's picture and sound codecs from what hls.js found in it
 * (BUFFER_CODECS): separate tracks, or one ("audiovideo") with both in one
 * string, joined — as an fMP4 stream's are, its sound first.
 */
export function splitCodecs(data: {
  video?: { codec?: string }; audio?: { codec?: string }; audiovideo?: { codec?: string };
}): { video: string | null; audio: string | null } {
  const both = (data.audiovideo?.codec ?? "").split(",").map((c) => c.trim()).filter(Boolean);
  return {
    video: data.video?.codec ?? both.find((c) => !AUDIO_CODEC.test(c)) ?? null,
    audio: data.audio?.codec ?? both.find((c) => AUDIO_CODEC.test(c)) ?? null,
  };
}

/** Just the codec: "H.264", "HEVC", "AAC". */
export function codecFamily(codec: string | null | undefined): string | null {
  const name = codecName(codec);
  if (!name) return null;
  if (/^(AAC|HE-AAC|xHE-AAC)/.test(name)) return "AAC";
  return name.split(" ")[0];
}
