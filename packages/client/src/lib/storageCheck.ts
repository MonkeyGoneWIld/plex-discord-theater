/**
 * Whether this page could keep the film itself across a pop-out — a check for
 * the log, not a feature yet.
 *
 * Discord's pop-out reloads the activity, and the page back finds what the
 * page before fetched only while the browser's HTTP cache still has it: on 14
 * October two pages back found their next 25 to 30 seconds there, and four
 * found it already let go, the bot sending the same segments again 50 to 70
 * seconds after the page before had them. Kept by the page itself in Cache
 * Storage, nothing else would push them out. But the last thing tried, a
 * service worker holding them as the page went (12 October), Discord blocked
 * outright, so before anything is built on Cache Storage this finds out
 * whether an activity may use it: once a page, it writes a megabyte, reads it
 * back, says how much room there is, and says whether the entry the page
 * before left was still there — which, after a pop-out, is the one answer
 * that matters.
 */
import { logEvent, logWarn } from "./log";

const CHECK_CACHE = "pdt-storage-check";
const CHECK_URL = "/__pdt-storage-check";
const CHECK_BYTES = 1_000_000;

/** A byte that says where in the entry it is, so a short or mangled read shows. */
const byteAt = (i: number) => (i * 31 + (i >> 8)) & 0xff;

let checked = false;

/** Run the check, once a page. Never throws, and nothing waits on it. */
export async function checkCacheStorage(): Promise<void> {
  if (checked) return;
  checked = true;
  const said: Record<string, unknown> = {};
  let step = "open";
  try {
    if (typeof caches === "undefined") {
      logWarn("Storage", "no Cache Storage in this page", { secureContext: window.isSecureContext });
      return;
    }
    const cache = await caches.open(CHECK_CACHE);

    step = "look for the page before's";
    const left = await cache.match(CHECK_URL);
    if (left) {
      const body = await left.arrayBuffer();
      const at = Number(left.headers.get("x-written-at"));
      said.pageBeforesEntry = body.byteLength === CHECK_BYTES ? "there, whole" : `there, ${body.byteLength} bytes`;
      if (Number.isFinite(at)) said.leftAgoS = Math.round((Date.now() - at) / 1000);
    } else {
      said.pageBeforesEntry = "none";
    }

    step = "write";
    const data = new Uint8Array(CHECK_BYTES);
    for (let i = 0; i < data.length; i++) data[i] = byteAt(i);
    const wroteFrom = performance.now();
    await cache.put(CHECK_URL, new Response(data, {
      headers: { "Content-Type": "application/octet-stream", "x-written-at": String(Date.now()) },
    }));
    said.writeMs = Math.round(performance.now() - wroteFrom);

    step = "read back";
    const readFrom = performance.now();
    const back = await cache.match(CHECK_URL);
    const got = back ? new Uint8Array(await back.arrayBuffer()) : null;
    said.readMs = Math.round(performance.now() - readFrom);
    let intact = got !== null && got.length === CHECK_BYTES;
    for (let i = 0; intact && i < CHECK_BYTES; i += 4093) intact = got![i] === byteAt(i);
    said.readBack = got === null ? "missing" : intact ? "intact" : "damaged";

    step = "room";
    const estimate = await navigator.storage?.estimate?.();
    if (estimate?.quota) said.quotaMB = Math.round(estimate.quota / 1e6);
    if (estimate?.usage != null) said.usedMB = Math.round(estimate.usage / 1e6);
    const persisted = await navigator.storage?.persisted?.();
    if (persisted !== undefined) said.persisted = persisted;

    if (said.readBack === "intact") logEvent("Storage", "Cache Storage works here", said);
    else logWarn("Storage", "Cache Storage took the entry but didn't give it back", said);
  } catch (err) {
    logWarn("Storage", "Cache Storage refused", {
      ...said,
      step,
      error: err instanceof Error ? `${err.name}: ${err.message}` : String(err),
    });
  }
}
