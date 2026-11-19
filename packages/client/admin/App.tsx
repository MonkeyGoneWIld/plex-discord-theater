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
import { timeOfDay } from "./format";
import { liveFeed } from "./live";
import { Icon, Logo } from "./icons";

type Tab = "activity" | "history" | "graphs" | "people" | "places" | "requests" | "caches" | "logs" | "settings";
const TABS: Array<{ id: Tab; label: string; group: "Monitor" | "Library" | "System" }> = [
  { id: "activity", label: "Activity", group: "Monitor" },
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
  // "#now" is the page's address from before it was called Activity: bookmarks to it still open it.
  const tab = TABS.find((t) => t.id === (h === "now" ? "activity" : h))?.id ?? "activity";
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
        <p className="muted">Enter the password set in <span className="mono">ADMIN_PASSWORD</span>.</p>
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
    // Opened with nothing after the address: Activity, and the address says so.
    if (!location.hash.replace("#", "") || location.hash === "#now") history.replaceState(null, "", "#activity");
    api.session().then((s) => setSignedIn(s.signedIn)).catch(() => setSignedIn(false));
    const onHash = () => {
      setRoute(routeFromHash());
      scrollTo(0, 0);
    };
    addEventListener("hashchange", onHash);
    return () => removeEventListener("hashchange", onHash);
  }, []);

  // The live feed, while signed in: opened again after a restart of the bot or a quiet spell
  // (live.ts); a session that ended says so, and the page goes back to its sign-in.
  useEffect(() => {
    if (!signedIn) return;
    return liveFeed<Overview>({
      url: "/api/live",
      onData: setData,
      onState: setLive,
      onSignedOut: () => setSignedIn(false),
      signedIn: () => api.session().then((s) => s.signedIn),
    });
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
        <a className="brand" href="#activity"><Logo /><span>Theater<br /><small>Dashboard</small></span></a>
        <nav aria-label="Pages">
          {GROUPS.map((g) => (
            <div key={g} className="nav-group">
              <div className="nav-label">{g}</div>
              {TABS.filter((t) => t.group === g).map((t) => (
                <a key={t.id} href={`#${t.id}`} title={t.label} aria-label={t.label} aria-current={tab === t.id ? "page" : undefined}
                  className={tab === t.id ? "nav-item active" : "nav-item"}>
                  <Icon name={t.id} />
                  <span>{t.label}</span>
                  {t.id === "activity" && sessions > 0 && <span className="nav-count">{sessions}</span>}
                </a>
              ))}
            </div>
          ))}
        </nav>
        <div className="sidebar-foot">
          <span className={`live ${live}`}>
            <span className="dot" />{live === "live" ? "Live" : live === "lost" ? "Reconnecting…" : "Connecting…"}
            {data && <span className="muted"> · {timeOfDay(data.at)}</span>}
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
          {tab === "activity" && <NowPlaying data={data} />}
          {tab === "history" && <History key={id ?? ""} id={id} onError={onError} />}
          {tab === "graphs" && <GraphsTab onError={onError} />}
          {tab === "people" && <People key={id ?? ""} id={id} onError={onError} />}
          {tab === "places" && <Places onError={onError} />}
          {tab === "requests" && <Requests onError={onError} />}
          {tab === "caches" && <Caches onError={onError} />}
          {tab === "logs" && <Logs onError={onError} route={id} />}
          {tab === "settings" && <Settings onError={onError} />}
        </main>
      </div>
    </div>
  );
}
