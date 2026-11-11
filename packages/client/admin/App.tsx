import { useCallback, useEffect, useState } from "react";
import { api, SignedOut } from "./api";
import type { Overview } from "./types";
import { NowPlaying } from "./NowPlaying";
import { Logs } from "./Logs";
import { Settings } from "./Settings";
import { History } from "./History";
import { People } from "./People";
import { Places } from "./Places";
import { Requests } from "./Requests";
import { Caches } from "./Caches";
import { utcTime } from "./format";

type Tab = "now" | "history" | "people" | "places" | "requests" | "caches" | "logs" | "settings";
const TABS: Array<{ id: Tab; label: string }> = [
  { id: "now", label: "Now playing" },
  { id: "history", label: "History" },
  { id: "people", label: "People" },
  { id: "places", label: "Servers" },
  { id: "requests", label: "Requests" },
  { id: "caches", label: "Caches" },
  { id: "logs", label: "Logs" },
  { id: "settings", label: "Settings" },
];

/** `#history/12`: the History tab, play 12. */
interface Route { tab: Tab; id: string | null }

function routeFromHash(): Route {
  const [h, id] = location.hash.replace("#", "").split("/");
  const tab = TABS.find((t) => t.id === h)?.id ?? "now";
  return { tab, id: id ? decodeURIComponent(id) : null };
}

function SignIn({ onDone }: { onDone: () => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <main className="signin">
      <form className="card signin-card" onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await api.login(password);
          onDone();
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
        } finally {
          setBusy(false);
        }
      }}>
        <h1>Theater admin</h1>
        <p className="muted">Sign in with the server's ADMIN_PASSWORD.</p>
        <label className="stack">
          <span>Password</span>
          <input type="password" autoFocus autoComplete="current-password" value={password}
            onChange={(e) => setPassword(e.target.value)} />
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy || !password}>{busy ? "Signing in…" : "Sign in"}</button>
      </form>
    </main>
  );
}

export function App() {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  const [route, setRoute] = useState<Route>(routeFromHash);
  const { tab, id } = route;
  const [data, setData] = useState<Overview | null>(null);
  const [live, setLive] = useState<"connecting" | "live" | "lost">("connecting");
  const [problem, setProblem] = useState<string | null>(null);

  const onError = useCallback((e: unknown) => {
    if (e instanceof SignedOut) setSignedIn(false);
    else setProblem(e instanceof Error ? e.message : String(e));
  }, []);

  useEffect(() => {
    api.session().then((s) => setSignedIn(s.signedIn)).catch(() => setSignedIn(false));
    const onHash = () => {
      setRoute(routeFromHash());
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // The live feed, while signed in. EventSource reconnects by itself; a
  // session that ended says so, and the page goes back to its sign-in.
  useEffect(() => {
    if (!signedIn) return;
    const es = new EventSource("/api/live");
    es.onopen = () => setLive("live");
    es.onmessage = (ev) => {
      setLive("live");
      setData(JSON.parse(ev.data) as Overview);
    };
    es.addEventListener("signed-out", () => {
      es.close();
      setSignedIn(false);
    });
    es.onerror = () => {
      setLive("lost");
      api.session().then((s) => { if (!s.signedIn) { es.close(); setSignedIn(false); } }).catch(() => {});
    };
    return () => es.close();
  }, [signedIn]);

  if (signedIn === null) return <p className="empty">Loading…</p>;
  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;

  return (
    <div className="shell">
      <header className="topbar">
        <div className="brand">Theater admin</div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <a key={t.id} href={`#${t.id}`} role="tab" aria-selected={tab === t.id}
              className={tab === t.id ? "tab active" : "tab"}>{t.label}</a>
          ))}
        </nav>
        <div className="topbar-right">
          <span className={`live ${live}`} title={data ? `Updated ${utcTime(data.at)} UTC` : ""}>
            <span className="dot" />{live === "live" ? "Live" : live === "lost" ? "Reconnecting…" : "Connecting…"}
            {data && <span className="muted"> · {utcTime(data.at)} UTC</span>}
          </span>
          <button className="ghost" onClick={async () => {
            await api.logout().catch(() => {});
            setSignedIn(false);
            setData(null);
          }}>Sign out</button>
        </div>
      </header>
      {problem && (
        <div className="banner" role="alert">
          {problem} <button className="link" onClick={() => setProblem(null)}>Dismiss</button>
        </div>
      )}
      <main className="content">
        {tab === "now" && <NowPlaying data={data} />}
        {tab === "history" && <History key={id ?? ""} id={id} onError={onError} />}
        {tab === "people" && <People key={id ?? ""} id={id} onError={onError} />}
        {tab === "places" && <Places onError={onError} />}
        {tab === "requests" && <Requests onError={onError} />}
        {tab === "caches" && <Caches onError={onError} />}
        {tab === "logs" && <Logs onError={onError} />}
        {tab === "settings" && <Settings onError={onError} />}
      </main>
    </div>
  );
}
