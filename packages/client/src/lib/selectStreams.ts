/**
 * Selecting a title's tracks on Plex before it plays, when its file may have
 * changed since its details were fetched.
 *
 * Track ids, and the part they are set on, belong to a file, and the details
 * the pages hold are cached: by the bot for up to a week. A film whose file
 * was replaced in Plex since has a new part with new ids, Plex refuses the
 * old one, and Play said only "Failed to configure playback" (Tenzing,
 * October 2026). So when Plex refuses, the title's details are fetched fresh,
 * the same tracks found in the new file by what they are, the way a saved
 * preference is, and set there.
 */
import { fetchFreshMeta, setStreams, versionOf, type PlexMeta, type ResolvedVersion } from "./api";
import { describeWatched, matchAudioTrack, matchSubtitleTrack, plexAudioChoice } from "./trackPrefs";

export interface StreamIds {
  audioStreamID?: number;
  subtitleStreamID?: number;
}

export interface SelectedStreams {
  /** The title's details fetched fresh, when the file had changed; null when
   *  the ones held were right. */
  meta: PlexMeta | null;
  /** An audio id from the details held, as it is in the file now. */
  audio(id: number | undefined): number | undefined;
  /** A subtitle id the same way. 0, none, stays none. */
  subtitle(id: number): number;
}

const same: SelectedStreams = { meta: null, audio: (id) => id, subtitle: (id) => id };

/** `ids` on `version`'s part, as setStreams; `mediaIndex` says which of the
 *  title's versions `version` is. */
export async function selectStreams(
  ratingKey: string,
  version: ResolvedVersion,
  ids: StreamIds,
  mediaIndex?: number,
): Promise<SelectedStreams> {
  try {
    if (version.partId == null) throw new Error("No part to set the tracks on");
    await setStreams(version.partId, ids);
    return same;
  } catch (err) {
    const meta = await fetchFreshMeta(ratingKey).catch(() => null);
    const now = meta ? versionOf(meta, mediaIndex) : null;
    if (!meta || now?.partId == null) throw err;
    // What each was, as a choice made for this title: a commentary or a
    // forced track stays one.
    const audio = (id: number | undefined) => {
      if (id === undefined) return undefined;
      const was = describeWatched(version, { audioStreamId: id, subtitleStreamId: -1 }).audio;
      return (matchAudioTrack(now.audioTracks, was && { ...was, forTitle: true }) ?? plexAudioChoice(now.audioTracks))?.id;
    };
    const subtitle = (id: number) => {
      if (id === 0) return 0;
      const was = describeWatched(version, { audioStreamId: -1, subtitleStreamId: id }).subtitle;
      return matchSubtitleTrack(now.subtitleTracks, was && { ...was, forTitle: true })?.id ?? 0;
    };
    const moved: StreamIds = {
      ...(ids.audioStreamID !== undefined ? { audioStreamID: audio(ids.audioStreamID) } : {}),
      ...(ids.subtitleStreamID !== undefined ? { subtitleStreamID: subtitle(ids.subtitleStreamID) } : {}),
    };
    console.warn("[Streams] Plex refused the tracks; set on the title's file as it is now", {
      ratingKey, partWas: version.partId, partNow: now.partId, was: ids, now: moved,
    });
    await setStreams(now.partId, moved);
    return { meta, audio, subtitle };
  }
}
