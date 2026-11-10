/** 1:02:03, or 2:03 under an hour. */
export function clock(totalS: number): string {
  const s = Math.max(0, Math.floor(totalS));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

/** "3 s", "4 min", "2 h 5 min". */
export function ago(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return m % 60 ? `${h} h ${m % 60} min` : `${h} h`;
}

/** 2026-11-10 23:36:04 UTC */
export function utc(at: number | string | null | undefined): string {
  if (at === null || at === undefined) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.toISOString().slice(0, 19).replace("T", " ")} UTC`;
}

/** 23:36:04 */
export function utcTime(at: number | string | null | undefined): string {
  if (at === null || at === undefined) return "—";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : d.toISOString().slice(11, 19);
}

/** 12.4 Mbps, or 850 kbps. */
export function rate(kbps: number | null | undefined): string {
  if (!kbps) return "—";
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(kbps >= 10_000 ? 0 : 1)} Mbps` : `${Math.round(kbps)} kbps`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** A viewer's quality ceiling: 0 is none. */
export function quality(kbps: number): string {
  return kbps ? `Up to ${rate(kbps)}` : "Original";
}

export function short(id: string | null | undefined, n = 8): string {
  return id ? id.slice(0, n) : "—";
}
