import { useState } from "react";
import { api } from "./api";
import type { CacheSums, CacheView, CachesResult } from "./types";
import { bytes, utc, utcTime } from "./format";
import { useLoad } from "./parts";

const share = (n: number | null) => (n === null ? "—" : `${Math.round(n * 100)}%`);

/** What the bot keeps, and what Discord's cache saved it. */
export function Caches({ onError }: { onError: (e: unknown) => void }) {
  const { data, busy, reload } = useLoad(() => api.caches(), [], onError);
  if (!data) return <p className="empty">{busy ? "Loading…" : "Couldn't read the caches."}</p>;
  return (
    <>
      <div className="toolbar-row">
        <span className="muted">Read at {utcTime(data.at)} UTC</span>
        <button className="ghost" onClick={reload} disabled={busy}>{busy ? "Reading…" : "Read again"}</button>
      </div>
      <Discord d={data.discord} />
      {data.caches.map((c) => <CacheCard key={c.id} c={c} />)}
    </>
  );
}

function SumTile({ label, s }: { label: string; s: CacheSums }) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{share(s.hitShare)}</div>
      <div className="tile-sub">of what players fetched came from Discord's cache</div>
      <div className="small nowrap">Fetched {bytes(s.httpBytes)}</div>
      <div className="small nowrap muted">From Discord's cache {bytes(s.edgeHitBytes)}</div>
      <div className="small nowrap muted">From the bot {bytes(s.botBytes)}</div>
      <div className="small nowrap muted">From other viewers {bytes(s.p2pBytes)}</div>
    </div>
  );
}

function Discord({ d }: { d: CachesResult["discord"] }) {
  const [open, setOpen] = useState(false);
  if (!d) {
    return (
      <section className="card">
        <h3>Discord's cache</h3>
        <p className="muted">Known only from the history, which isn't kept: it needs the bot's data folder to be writable.</p>
      </section>
    );
  }
  const titles = open ? d.titles : d.titles.slice(0, 10);
  return (
    <section className="card">
      <h3>Discord's cache</h3>
      <p className="muted small">
        Segments reach players through Discord's proxy, which keeps some: a segment it already has is never asked
        of the bot. These are what the players reported.
      </p>
      <div className="tiles">
        <SumTile label="Last 24 hours" s={d.day} />
        <SumTile label="Last 7 days" s={d.week} />
        <SumTile label="Since the history began" s={d.all} />
      </div>
      <h4>By title</h4>
      {d.titles.length === 0 ? <p className="muted">Nothing played yet.</p> : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr><th>Title</th><th>Plays</th><th>Fetched</th><th>From Discord's cache</th><th>Share</th><th>From the bot</th><th>From other viewers</th></tr>
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
        <button className="link" onClick={() => setOpen(!open)}>{open ? "Show the top 10" : `Show all ${d.titles.length}`}</button>
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
        <dt>Where</dt><dd className="mono">{c.where}</dd>
        <dt>How long it's kept</dt><dd>{c.kept}</dd>
      </dl>
      {c.list.length > 0 && (
        <div className="stream cache-list">
          <button className="stream-head" onClick={() => setOpen(!open)} aria-expanded={open}>
            <span className="chev" aria-hidden>{open ? "▾" : "▸"}</span>
            <span>What it holds{c.listNote ? ` (${c.listNote.toLowerCase()})` : ` (${c.list.length})`}</span>
          </button>
          {open && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Title</th><th>Item</th><th>Size</th><th>Kept since</th><th>More</th></tr></thead>
                <tbody>
                  {c.list.map((it) => (
                    <tr key={it.name}>
                      <td>{it.title ? <strong>{it.title}</strong> : <span className="muted">{it.ratingKey ? `Plex item ${it.ratingKey}` : "—"}</span>}</td>
                      <td className="mono">{it.name}</td>
                      <td className="nowrap">{it.bytes === null ? "—" : bytes(it.bytes)}</td>
                      <td className="nowrap">{it.at ? utc(it.at) : "—"}</td>
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
