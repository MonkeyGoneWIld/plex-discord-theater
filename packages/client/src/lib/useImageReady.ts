import { useEffect, useState } from "react";

/**
 * Whether `url` has finished decoding, so a page can wait for its backdrop
 * instead of letting it wash in a beat after the text.
 *
 * Returns true immediately when there's no URL to wait for, and also on error —
 * a backdrop that 404s must never strand the page behind a spinner. The browser
 * cache means an image already fetched resolves on the first tick.
 */
export function useImageReady(url: string | null | undefined): boolean {
  const [ready, setReady] = useState(!url);

  useEffect(() => {
    if (!url) {
      setReady(true);
      return;
    }
    setReady(false);
    let cancelled = false;
    const img = new Image();
    const done = () => { if (!cancelled) setReady(true); };
    img.onload = done;
    img.onerror = done;
    img.src = url;
    // A cached image can be complete before the handlers are attached.
    if (img.complete) done();
    return () => { cancelled = true; };
  }, [url]);

  return ready;
}
