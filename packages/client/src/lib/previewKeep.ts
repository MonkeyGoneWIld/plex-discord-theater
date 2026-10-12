/**
 * The seek bar's preview frames, kept apart from the controls that show them.
 *
 * The controls go away while the Activity PiP is open, and the frames went
 * with them: coming back to the activity fetched every pass again, forty
 * megabytes for a long film. Now the frames wait here for the controls to
 * come back to the same part (parkPreview, takeParkedPreview), and go only
 * with the player (dropParkedPreview) or another part. What there is, at
 * either moment, is what a reload of the activity carries (lib/popOutCarry).
 */
import type { ProgressivePreviewReader } from "./previewFrames";
import type { PreviewStatus } from "./previewStatus";
import { carrySource } from "./popOutCarry";

export interface KeptPreview {
  partId: number;
  reader: ProgressivePreviewReader;
  status: PreviewStatus;
}

/** Being read, by controls that are there. */
let active: KeptPreview | null = null;
/** Waiting for the controls to come back. */
let parked: KeptPreview | null = null;

/** These frames are the ones the controls are reading now. */
export function previewInUse(kept: KeptPreview): void {
  active = kept;
}

/** The controls have let go of these without throwing them away. */
export function previewDone(kept: KeptPreview): void {
  if (active === kept) active = null;
}

/** The controls went; keep these for them. */
export function parkPreview(kept: KeptPreview): void {
  if (active === kept) active = null;
  if (parked && parked !== kept) parked.reader.dispose();
  parked = kept;
}

/** The frames kept for `partId`, if any — once. Any for another part go. */
export function takeParkedPreview(partId: number): KeptPreview | null {
  const kept = parked;
  parked = null;
  if (kept && kept.partId !== partId) {
    kept.reader.dispose();
    return null;
  }
  return kept;
}

/** The player went: nothing comes back for these. */
export function dropParkedPreview(): void {
  parked?.reader.dispose();
  parked = null;
}

carrySource("preview", () => {
  const kept = active ?? parked;
  const frames = kept?.reader.exportFrames();
  return kept && frames && frames.frames.length > 0 ? { preview: { ...frames, partId: kept.partId } } : null;
});
