/**
 * The seek bar's preview frames, kept apart from the controls that show them.
 *
 * The controls go away while the Activity PiP is open, and the frames went
 * with them: coming back to the activity fetched every pass again, forty
 * megabytes for a long film. Now the frames wait here for the controls to
 * come back to the same part (parkPreview, takeParkedPreview), and go only
 * with the player (dropParkedPreview) or another part.
 */
import type { ProgressivePreviewReader } from "./previewFrames";
import type { PreviewStatus } from "./previewStatus";

export interface KeptPreview {
  partId: number;
  reader: ProgressivePreviewReader;
  status: PreviewStatus;
}

/** Waiting for the controls to come back. */
let parked: KeptPreview | null = null;

/** The controls went; keep these for them. */
export function parkPreview(kept: KeptPreview): void {
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
