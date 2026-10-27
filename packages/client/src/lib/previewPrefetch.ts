import { authUrl } from "./api";

/**
 * The first pass of a part's preview frames, fetched while somebody is on the
 * title's page — whoever they are: anyone in the room can look along the seek
 * bar, the host to skip and everyone else to show them where.
 *
 * The seek bar (Controls) fetches a part's preview frames in passes as the
 * film plays, the first as soon as it starts, since skipping mostly happens
 * then. But the start is when the picture's own first segments are coming
 * in, and the first pass — a megabyte or two — came in beside them: on
 * Animal House on 11 October it took eight seconds to arrive, and the viewer
 * it went to stalled three seconds into the film for want of its second
 * segment. Fetched here, it is in hand before Play is pressed, and the seek
 * bar takes it from here instead of asking again (takePreviewStart).
 *
 * A few parts are kept at once, the last ones fetched.
 */

const KEEP = 3;

export interface PrefetchedPreview {
  /** As the server sent it: which form of index this is. */
  contentType: string;
  chunks: Uint8Array[];
}

const fetched = new Map<number, Promise<PrefetchedPreview | null>>();

/** Which of its previews a part's are, as the server says with its first
 *  pass (X-Preview-Version): what its later passes are shared by between
 *  players (lib/sideShare). */
const versions = new Map<number, string>();

export function rememberPreviewVersion(partId: number, version: string | null): void {
  if (version) versions.set(partId, version);
}

export function previewVersionOf(partId: number): string | null {
  return versions.get(partId) ?? null;
}

/** Where one pass of a part's preview frames is fetched from. */
export function previewPassPath(partId: number, pass: number): string {
  return `/api/plex/preview/${partId}/index?progressive=2&pass=${pass}`;
}

/** Fetch the first pass of this part's preview frames, once. */
export function prefetchPreviewStart(partId: number, fetchFn: typeof fetch = fetch): void {
  if (fetched.has(partId)) return;
  const reading = (async (): Promise<PrefetchedPreview | null> => {
    try {
      const res = await fetchFn(authUrl(previewPassPath(partId, 0)));
      if (!res.ok || !res.body) return null;
      const contentType = res.headers.get("content-type") ?? "";
      rememberPreviewVersion(partId, res.headers.get("x-preview-version"));
      const chunks: Uint8Array[] = [];
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value?.length) chunks.push(value);
      }
      return { contentType, chunks };
    } catch {
      return null;
    }
  })();
  fetched.set(partId, reading);
  // A failed one is asked for again next time, here or by the seek bar.
  void reading.then((got) => { if (!got && fetched.get(partId) === reading) fetched.delete(partId); });
  while (fetched.size > KEEP) fetched.delete(fetched.keys().next().value!);
}

/**
 * The first pass fetched ahead for this part — waited for if it is still
 * coming in — or null when it wasn't.
 */
export function takePreviewStart(partId: number): Promise<PrefetchedPreview | null> | null {
  return fetched.get(partId) ?? null;
}

/** For tests: forget everything fetched. */
export function forgetPreviewStarts(): void {
  fetched.clear();
}
