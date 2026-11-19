/**
 * The dashboard's live feed (admin/live.ts).
 *
 * 19 November, 20:47:22 UTC: the bot restarted while the dashboard was open;
 * a session began at 20:54:29 UTC and Activity did not show it until the page
 * was reloaded. While the bot restarts, the request for the feed gets an error
 * answer; the browser then closes the EventSource for good and the page went
 * on showing the overview from before the restart.
 */
import { liveFeed, type LiveSource } from "../admin/live";

let pass = 0;
let fail = 0;
function check(name: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) { pass++; return; }
  fail++;
  console.log(`FAIL ${name}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`);
}

/** A stand-in for EventSource, and a clock and timers the test moves on by hand. */
class Source implements LiveSource {
  readyState = 0;
  onopen: ((ev: Event) => void) | null = null;
  onmessage: ((ev: MessageEvent) => void) | null = null;
  onerror: ((ev: Event) => void) | null = null;
  closed = false;
  listeners = new Map<string, (ev: Event) => void>();
  addEventListener(type: string, fn: (ev: Event) => void) { this.listeners.set(type, fn); }
  close() { this.closed = true; this.readyState = 2; }
  opened() { this.readyState = 1; this.onopen?.({} as Event); }
  send(data: unknown) { this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent); }
  /** An error the browser retries (a dropped connection), or gives up on (an error answer). */
  error(givesUp: boolean) { this.readyState = givesUp ? 2 : 0; this.onerror?.({} as Event); }
}

function rig(signedIn = true) {
  let now = 0;
  let nextId = 1;
  const pending = new Map<number, { at: number; fn: () => void; every: number | null }>();
  const sources: Source[] = [];
  const data: unknown[] = [];
  const states: string[] = [];
  let signedOut = 0;
  const stop = liveFeed<unknown>({
    url: "/api/live",
    onData: (d) => data.push(d),
    onState: (s) => states.push(s),
    onSignedOut: () => signedOut++,
    signedIn: () => Promise.resolve(signedIn),
    open: () => { const s = new Source(); sources.push(s); return s; },
    retryMs: 3_000,
    quietMs: 15_000,
    now: () => now,
    timers: {
      setTimeout: (fn, ms) => { const id = nextId++; pending.set(id, { at: now + ms, fn, every: null }); return id; },
      clearTimeout: (id) => { pending.delete(id as number); },
      setInterval: (fn, ms) => { const id = nextId++; pending.set(id, { at: now + ms, fn, every: ms }); return id; },
      clearInterval: (id) => { pending.delete(id as number); },
    },
  });
  /** Moves the clock on, running what falls due on the way. */
  const wait = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...pending.entries()].filter(([, p]) => p.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, p] = due;
      now = p.at;
      if (p.every === null) pending.delete(id); else p.at += p.every;
      p.fn();
    }
    now = until;
  };
  return { sources, data, states, stop, wait, signedOut: () => signedOut, timers: () => pending.size };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

console.log("\n— the overview as it comes —");
{
  const f = rig();
  f.sources[0].opened();
  f.sources[0].send({ rooms: 1 });
  check("each message is the page's overview, and the feed is live", [f.data, f.states], [[{ rooms: 1 }], ["live", "live"]]);
  f.stop();
}

console.log("\n— the bot restarts: the browser gives up on the feed —");
{
  const f = rig();
  f.sources[0].opened();
  f.sources[0].send({ rooms: 0 });
  f.sources[0].error(true);
  await settle();
  check("the page says it lost the feed", f.states.at(-1), "lost");
  f.wait(2_999);
  check("  not opened again before 3 seconds", f.sources.length, 1);
  f.wait(1);
  check("  a new feed after 3 seconds", f.sources.length, 2);
  f.sources[1].opened();
  f.sources[1].send({ rooms: 1 });
  check("  the session begun since shows, with no reload", [f.data.at(-1), f.states.at(-1)], [{ rooms: 1 }, "live"]);
  check("  the old feed was closed", f.sources[0].closed, true);
  f.sources[1].error(true);
  f.wait(3_000);
  check("  and again the next time", f.sources.length, 3);
  f.stop();
}

console.log("\n— a dropped connection the browser retries itself —");
{
  const f = rig();
  f.sources[0].opened();
  f.sources[0].send({});
  f.sources[0].error(false);
  f.wait(3_000);
  check("no second feed while the browser retries", f.sources.length, 1);
  f.sources[0].opened();
  f.sources[0].send({});
  f.wait(10_000);
  check("  nor once it is back", f.sources.length, 1);
  f.stop();
}

console.log("\n— a feed that looks open but brings nothing —");
{
  const f = rig();
  f.sources[0].opened();
  f.sources[0].send({});
  f.wait(14_000);
  check("open while it has had something within 15 seconds", f.sources.length, 1);
  f.wait(6_000);
  check("  a new one when nothing came for 15 seconds", [f.sources.length, f.sources[0].closed, f.states.at(-1)], [2, true, "lost"]);
  f.stop();
}

console.log("\n— signed out —");
{
  const f = rig();
  f.sources[0].opened();
  f.sources[0].listeners.get("signed-out")?.({} as Event);
  check("the server ends the sign-in: the page goes back to sign in, the feed closed for good",
    [f.signedOut(), f.sources[0].closed, f.timers()], [1, true, 0]);
  f.wait(60_000);
  check("  and not opened again", f.sources.length, 1);
}
{
  const f = rig(false);
  f.sources[0].error(true);
  await settle();
  f.wait(60_000);
  check("an error, and the sign-in no longer holds: the page goes back to sign in, no new feed",
    [f.signedOut(), f.sources.length], [1, 1]);
}
{
  const f = rig();
  f.stop();
  f.wait(60_000);
  check("closed by the page (signed out, or the page left): no new feed, no timers", [f.sources.length, f.sources[0].closed, f.timers()], [1, true, 0]);
}

console.log(`admin-live: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
