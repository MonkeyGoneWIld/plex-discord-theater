import { SplitBar } from "./viz";
import { useState } from "react";
import { api } from "./api";
import type { CacheSums, CacheView, CachesResult } from "./types";
import { bytes, dateTime, timeOfDay } from "./format";
import { useLoad } from "./parts";
import { MiniChart } from "./lazy";

const share = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

/** What the bot keeps, and what Discord's cache saved it. */
export function Caches({ onError }: { onError: (e: unknown) => void }) {
  const { data, busy, reload } = useLoad(() => api.caches(), [], onError);
  if (!data) return <p className="empty">{busy ? "Loading…" : "The caches could not be read."}</p>;
  return (
    <>
      <div className="page-head with-action">
        <div>
          <h1>Caches</h1>
          <p className="muted">What the server stores, and how much Discord's cache saves it. Read at {timeOfDay(data.at)}.</p>
        </div>
        <button className="ghost" onClick={reload} disabled={busy}>{busy ? "Refreshing…" : "Refresh"}</button>
      </div>
      <Storage caches={data.caches} />
      <Discord d={data.discord} />
      {data.discord && <MiniChart kind="data" onError={onError} />}
      {data.caches.map((c) => <CacheCard key={c.id} c={c} />)}
    </>
  );
}

/** Everything the server stores, and how much of it each cache is. One hue: the bars compare sizes. */
function Storage({ caches }: { caches: CacheView[] }) {
  const total = caches.reduce((sum, c) => sum + c.bytes, 0);
  const items = caches.reduce((sum, c) => sum + c.items, 0);
  const rows = [...caches].sort((a, b) => b.bytes - a.bytes);
  return (
    <section className="card">
      <header className="room-head">
        <div>
          <h3>Storage used</h3>
          <p className="muted small cache-what">The total size of everything the server stores, and each cache's share of it. Largest first.</p>
        </div>
        <div className="cache-size">
          <strong className="storage-total">{bytes(total)}</strong>
          <div className="muted small">{items.toLocaleString("en")} {items === 1 ? "item" : "items"} in {caches.length} caches</div>
        </div>
      </header>
      <div className="table-wrap">
        <table className="table storage">
          <thead><tr><th>Cache</th><th>Share of total</th><th className="num">Size</th><th className="num">Limit</th><th className="num">Items</th></tr></thead>
          <tbody>
            {rows.map((c) => {
              const part = total > 0 ? c.bytes / total : 0;
              return (
                <tr key={c.id}>
                  <td><strong>{c.name}</strong></td>
                  <td className="storage-share">
                    <span className="storage-bar" aria-hidden><span style={{ width: `${part * 100}%` }} className={c.bytes > 0 ? "some" : ""} /></span>
                    <span className="storage-pct">{part > 0 && part < 0.001 ? "<0.1%" : `${(part * 100).toFixed(1)}%`}</span>
                  </td>
                  <td className="num nowrap">{bytes(c.bytes)}</td>
                  <td className="num nowrap muted">{c.limitBytes ? bytes(c.limitBytes) : "None"}</td>
                  <td className="num">{c.items.toLocaleString("en")}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr><td><strong>Total</strong></td><td /><td className="num nowrap"><strong>{bytes(total)}</strong></td><td /><td className="num"><strong>{items.toLocaleString("en")}</strong></td></tr>
          </tfoot>
        </table>
      </div>
    </section>
  );
}

function SumTile({ label, s }: { label: string; s: CacheSums }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{share(s.hitShare)}</div>
      <div className="tile-sub">of HTTP data was served by Discord's cache</div>
      <div className="small nowrap">Downloaded over HTTP {bytes(s.httpBytes)}</div>
      <SplitBar server={s.botBytes} cache={Math.min(s.edgeHitBytes, s.httpBytes)} peers={s.p2pBytes} />
    </div>
  );
}

function Discord({ d }: { d: CachesResult["discord"] }) {
  const [open, setOpen] = useState(false);
  if (!d) {
    return (
      <section className="card">
        <h3>Discord cache efficiency</h3>
        <p className="muted">Unavailable: history recording is off. It needs a writable data folder.</p>
      </section>
    );
  }
  const titles = open ? d.titles : d.titles.slice(0, 10);
  return (
    <section className="card">
      <h3>Discord cache efficiency</h3>
      <p className="muted small">
        Video segments reach players through Discord's proxy, which caches them. A segment already in its cache is
        served without reaching this server. Figures are reported by the players.
      </p>
      <div className="tiles">
        <SumTile label="Last 24 hours" s={d.day} />
        <SumTile label="Last 7 days" s={d.week} />
        <SumTile label="All time" s={d.all} />
      </div>
      <h4>By title</h4>
      {d.titles.length === 0 ? <p className="muted">No sessions recorded yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Title</th><th>Sessions</th><th>Over HTTP</th><th>Discord cache</th><th>Cache share</th><th>Server</th><th>Peers</th></tr>
            </thead>
            <tbody>
              {titles.map((t) => (
                <tr key={t.ratingKey}>
                  <td><strong>{t.title ?? t.ratingKey}</strong></td>
                  <td>{t.plays ?? "—"}</td>
                  <td className="nowrap">{bytes(t.httpBytes)}</td>
                  <td className="nowrap">{bytes(t.edgeHitBytes)}</td>
                  <td>{share(t.hitShare)}</td>
                  <td className="nowrap">{bytes(t.botBytes)}</td>
                  <td className="nowrap">{bytes(t.p2pBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {d.titles.length > 10 && (
        <button className="link" onClick={() => setOpen(!open)}>{open ? "Show top 10" : `Show all ${d.titles.length}`}</button>
      )}
    </section>
  );
}

function CacheCard({ c }: { c: CacheView }) {
  const [open, setOpen] = useState(false);
  const pct = c.limitBytes ? Math.min(100, (c.bytes / c.limitBytes) * 100) : null;
  return (
    <section className="card">
      <header className="room-head">
        <div>
          <h3>{c.name}</h3>
          <p className="muted small cache-what">{c.what}</p>
        </div>
        <div className="cache-size">
          <strong>{bytes(c.bytes)}</strong>
          {c.limitBytes ? <span className="muted"> of {bytes(c.limitBytes)}</span> : <span className="muted"> · no limit</span>}
          <div className="muted small">{c.items} {c.items === 1 ? "item" : "items"}</div>
        </div>
      </header>
      {pct !== null && (
        <div className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}
          aria-label={`${c.name}: ${Math.round(pct)}% full`}>
          <span className={pct >= 90 ? "warn" : ""} style={{ width: `${pct}%` }} />
        </div>
      )}
      <dl className="grid">
        <dt>Location</dt><dd className="mono">{c.where}</dd>
        <dt>Retention</dt><dd>{c.kept}</dd>
      </dl>
      {c.list.length > 0 && (
        <div className="stream cache-list">
          <button className="stream-head" onClick={() => setOpen(!open)} aria-expanded={open}>
            <span className="chev" aria-hidden>{open ? "▾" : "▸"}</span>
            <span>Contents{c.listNote ? ` (${c.listNote.toLowerCase()})` : ` (${c.list.length})`}</span>
          </button>
          {open && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Title</th><th>Item</th><th>Size</th><th>Stored</th><th>Details</th></tr></thead>
                <tbody>
                  {c.list.map((it) => (
                    <tr key={it.name}>
                      <td>{it.title ? <strong>{it.title}</strong> : <span className="muted">{it.ratingKey ? `Plex item ${it.ratingKey}` : "—"}</span>}</td>
                      <td className="mono">{it.name}</td>
                      <td className="nowrap">{it.bytes === null ? "—" : bytes(it.bytes)}</td>
                      <td className="nowrap">{it.at ? dateTime(it.at) : "—"}</td>
                      <td className="small">{it.detail ?? ""}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {c.list.length === 0 && <p className="muted small">Empty.</p>}
    </section>
  );
}
