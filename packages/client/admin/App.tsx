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
import { GraphsTab } from "./lazy";
import { utcTime } from "./format";
import { Icon, Logo } from "./icons";

type Tab = "now" | "history" | "graphs" | "people" | "places" | "requests" | "caches" | "logs" | "settings";
const TABS: Array<{ id: Tab; label: string; group: "Monitor" | "Library" | "System" }> = [
  { id: "now", label: "Now Playing", group: "Monitor" },
  { id: "history", label: "History", group: "Monitor" },
  { id: "graphs", label: "Statistics", group: "Monitor" },
  { id: "people", label: "Users", group: "Library" },
  { id: "places", label: "Discord Servers", group: "Library" },
  { id: "requests", label: "Requests", group: "Library" },
  { id: "caches", label: "Caches", group: "System" },
  { id: "logs", label: "Logs", group: "System" },
  { id: "settings", label: "System", group: "System" },
];
const GROUPS = ["Monitor", "Library", "System"] as const;

/** `#history/12`: the History page, session 12. */
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
        <div className="signin-brand"><Logo size={40} /><h1>Theater Dashboard</h1></div>
        <p className="muted">Sign in with the password set in the server's <span className="mono">ADMIN_PASSWORD</span>.</p>
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

  // The browser tab says what is playing, so it can be told at a glance.
  const sessions = data?.rooms.filter((r) => r.ratingKey).length ?? 0;
  useEffect(() => {
    document.title = sessions > 0 ? `(${sessions}) Theater Dashboard` : "Theater Dashboard";
  }, [sessions]);

  if (signedIn === null) return <p className="empty">Loading…</p>;
  if (!signedIn) return <SignIn onDone={() => setSignedIn(true)} />;

  return (
    <div className="shell">
      <aside className="sidebar">
        <a className="brand" href="#now"><Logo /><span>Theater<br /><small>Dashboard</small></span></a>
        <nav aria-label="Pages">
          {GROUPS.map((g) => (
            <div key={g} className="nav-group">
              <div className="nav-label">{g}</div>
              {TABS.filter((t) => t.group === g).map((t) => (
                <a key={t.id} href={`#${t.id}`} title={t.label} aria-label={t.label} aria-current={tab === t.id ? "page" : undefined}
                  className={tab === t.id ? "nav-item active" : "nav-item"}>
                  <Icon name={t.id} />
                  <span>{t.label}</span>
                  {t.id === "now" && sessions > 0 && <span className="nav-count">{sessions}</span>}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`live ${live}`} title={data ? `Last update ${utcTime(data.at)} UTC` : ""}>
            <span className="dot" />{live === "live" ? "Live" : live === "lost" ? "Reconnecting…" : "Connecting…"}
            {data && <span className="muted"> · {utcTime(data.at)} UTC</span>}
          </span>
          <button className="ghost signout" onClick={async () => {
            await api.logout().catch(() => {});
            setSignedIn(false);
            setData(null);
          }}><Icon name="signout" size={16} />Sign out</button>
        </div>
      </aside>
      <div className="main">
        {problem && (
          <div className="banner" role="alert">
            <Icon name="alert" size={16} /> {problem} <button className="link" onClick={() => setProblem(null)}>Dismiss</button>
          </div>
        )}
        <main className="content">
          {tab === "now" && <NowPlaying data={data} />}
          {tab === "history" && <History key={id ?? ""} id={id} onError={onError} />}
          {tab === "graphs" && <GraphsTab onError={onError} />}
          {tab === "people" && <People key={id ?? ""} id={id} onError={onError} />}
          {tab === "places" && <Places onError={onError} />}
          {tab === "requests" && <Requests onError={onError} />}
          {tab === "caches" && <Caches onError={onError} />}
          {tab === "logs" && <Logs onError={onError} />}
          {tab === "settings" && <Settings onError={onError} />}
        </main>
      </div>
    </div>
  );
}
