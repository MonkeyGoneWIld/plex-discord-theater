/**
 * The dashboard's live feed: the server sends the overview every 2 seconds
 * over one EventSource. The browser reconnects an EventSource by itself after
 * a network error, but not after an error answer (a proxy's 502 while the bot
 * restarts, say): that one stays closed and the page stops updating. So the
 * feed opens a new one itself when the browser gives up, or when nothing has
 * come for a while.
 */

/** What the feed needs of an EventSource (a stand-in in the tests). */
export interface LiveSource {
  readonly readyState: number;
  onopen: ((ev: Event) => void) | null;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: Event) => void) | null;
  addEventListener(type: string, fn: (ev: Event) => void): void;
  close(): void;
}

/** EventSource.CLOSED: the browser will not reconnect it. */
const CLOSED = 2;

export interface LiveOptions<T> {
  url: string;
  onData: (data: T) => void;
  onState: (state: "live" | "lost") => void;
  onSignedOut: () => void;
  /** Whether the sign-in still holds, asked after an error. */
  signedIn: () => Promise<boolean>;
  open?: (url: string) => LiveSource;
  /** How long after the browser gives up to open a new one. */
  retryMs?: number;
  /** How long with nothing from the server before opening a new one. */
  quietMs?: number;
  now?: () => number;
  timers?: {
    setTimeout: (fn: () => void, ms: number) => unknown;
    clearTimeout: (id: unknown) => void;
    setInterval: (fn: () => void, ms: number) => unknown;
    clearInterval: (id: unknown) => void;
  };
}

/** Opens the feed; the function it returns closes it for good. */
export function liveFeed<T>(o: LiveOptions<T>): () => void {
  const open = o.open ?? ((url: string) => new EventSource(url) as unknown as LiveSource);
  const retryMs = o.retryMs ?? 3_000;
  const quietMs = o.quietMs ?? 15_000;
  const now = o.now ?? (() => Date.now());
  const timers = o.timers ?? {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: unknown) => clearTimeout(id as ReturnType<typeof setTimeout>),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (id: unknown) => clearInterval(id as ReturnType<typeof setInterval>),
  };
  let stopped = false;
  let es: LiveSource | null = null;
  let heardAt = now();
  let retry: unknown = null;

  const stop = () => {
    stopped = true;
    es?.close();
    if (retry !== null) timers.clearTimeout(retry);
    timers.clearInterval(watch);
  };
  const reopen = () => {
    if (stopped) return;
    if (retry !== null) { timers.clearTimeout(retry); retry = null; }
    es?.close();
    connect();
  };
  const connect = () => {
    heardAt = now();
    const s = open(o.url);
    es = s;
    s.onopen = () => { heardAt = now(); o.onState("live"); };
    s.onmessage = (ev) => {
      heardAt = now();
      o.onState("live");
      o.onData(JSON.parse(String(ev.data)) as T);
    };
    s.addEventListener("signed-out", () => { stop(); o.onSignedOut(); });
    s.onerror = () => {
      if (stopped || es !== s) return;
      o.onState("lost");
      o.signedIn().then((ok) => { if (!ok && !stopped) { stop(); o.onSignedOut(); } }).catch(() => {});
      if (s.readyState === CLOSED && retry === null) retry = timers.setTimeout(() => { retry = null; reopen(); }, retryMs);
    };
  };
  // Nothing for a while, though the connection looks open (or the browser is still trying): a new one.
  const watch = timers.setInterval(() => {
    if (!stopped && now() - heardAt > quietMs) { o.onState("lost"); reopen(); }
  }, Math.max(1_000, Math.round(quietMs / 3)));
  connect();
  return stop;
}
