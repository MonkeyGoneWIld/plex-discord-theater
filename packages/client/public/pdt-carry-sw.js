/**
 * Holds what a page of the activity hands it as Discord reloads the activity —
 * popping it out of its window, and back in — until the page that replaces it
 * asks for it; and no longer than a minute. In memory only, here, outside the
 * page: a page going away can't write anything that lasts (IndexedDB drops a
 * write begun while the page unloads), but a message to this worker is out of
 * the page the moment it is sent. See src/lib/popOutCarry.ts.
 *
 * The page that replaces it can ask before what the old one sent has arrived
 * — megabytes against a few bytes, on different pages' channels — so the old
 * page says it is sending first ("keeping", which arrives ahead of the rest
 * of its messages), and an ask that comes while that is still on its way
 * waits for it. Asked with nothing coming, it answers at once.
 *
 * No fetch handler: it never stands between the activity and the network.
 */
const HOLD_MS = 60_000;
const ASK_WAIT_MS = 3_000;

let held = null;
let release = null;
let asking = null;
/** When a page said it is sending something, until it has arrived. */
let coming = 0;

function drop() {
  held = null;
  if (release) {
    release();
    release = null;
  }
}

function answer(carry) {
  const ask = asking;
  asking = null;
  if (!ask) return;
  clearTimeout(ask.timer);
  ask.port.postMessage({ carry });
  ask.done();
}

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("message", (event) => {
  const msg = event.data || {};
  if (msg.type === "keeping") {
    coming = Date.now();
  } else if (msg.type === "keep") {
    coming = 0;
    drop();
    // Already asked for: straight to the page that asked.
    if (asking) {
      answer(msg.carry);
      return;
    }
    held = { carry: msg.carry, at: Date.now() };
    // Kept alive, holding it, until it is taken or let go — no longer.
    event.waitUntil(new Promise((resolve) => {
      const timer = setTimeout(() => { held = null; release = null; resolve(); }, HOLD_MS);
      release = () => { clearTimeout(timer); resolve(); };
    }));
  } else if (msg.type === "take") {
    const port = event.ports && event.ports[0];
    if (!port) return;
    const carry = held && Date.now() - held.at < HOLD_MS ? held.carry : null;
    if (carry || !coming || Date.now() - coming > ASK_WAIT_MS) {
      if (carry) drop();
      port.postMessage({ carry });
      return;
    }
    answer(null);
    event.waitUntil(new Promise((done) => {
      asking = { port, done, timer: setTimeout(() => answer(null), ASK_WAIT_MS) };
    }));
  } else if (msg.type === "drop") {
    coming = 0;
    drop();
  }
});
