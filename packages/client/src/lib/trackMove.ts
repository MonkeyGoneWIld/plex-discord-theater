/**
 * What a stream assignment from the server means for the tracks this player
 * was on: whether somebody else (the host) moved it onto others, which the
 * player says on its loading screen, and whether a change this player asked
 * for is still on its way.
 */

/** What the player had acted on before this assignment. */
export interface TracksHeld {
  /** The variant last acted on, null before the first. */
  variantKey: string | null;
  /** The title that variant was for. */
  ratingKey: string | null;
  audioStreamId: number | null;
  subtitleStreamId: number | null;
  /** Whether this player has asked for a change the server hasn't answered. */
  asked: boolean;
}

/** The assignment that has just arrived. */
export interface TracksAssigned {
  variantKey: string;
  ratingKey: string | null;
  audioStreamId: number;
  subtitleStreamId: number;
}

export interface TracksRead {
  /** Moved onto other tracks by somebody else: which of them changed. */
  movedBy: "audio" | "subtitle" | null;
  /** Whether a change this player asked for is still to come. */
  stillAsked: boolean;
}

/**
 * The tracks a variant key is for, without the part that only says how this
 * player is sent them: the same tracks in H.264, for a screen in SDR or as a
 * copy, by what this player decodes (the server's seatOf), is no change of
 * tracks.
 */
const tracksOf = (key: string | null) => key?.replace(/\/(h264|sdr|hevc|8bit)$/, "") ?? null;

export function readAssignment(held: TracksHeld, next: TracksAssigned): TracksRead {
  const hadTracks = held.variantKey !== null;
  // On the same title. A new title comes with its own file's tracks, ids and
  // all, so its assignment always differs from the last title's — and the
  // host starting Avatar after Toy Story read as the host switching audio.
  const sameTitle = held.ratingKey === next.ratingKey;
  const audioChanged = held.audioStreamId !== (next.audioStreamId || null);
  const subtitleChanged = held.subtitleStreamId !== next.subtitleStreamId;
  // A move is to other audio or subtitles. Only the quality changed is none:
  // that was read as the host switching subtitles.
  const moved =
    hadTracks && sameTitle && tracksOf(held.variantKey) !== tracksOf(next.variantKey) &&
    (audioChanged || subtitleChanged) && !held.asked;
  return {
    movedBy: moved ? (audioChanged ? "audio" : "subtitle") : null,
    // The stream this player is on, said again, answers nothing it asked. On
    // 4 November Firefox joined on the host's 8 Mbps and asked for Auto; the
    // server said again the stream it had just started, which took the ask
    // with it, and Auto, arriving after, read as the host switching subtitles.
    stillAsked: held.asked && next.variantKey === held.variantKey,
  };
}
