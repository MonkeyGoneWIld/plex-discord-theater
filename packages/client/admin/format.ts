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

// Times are stored in UTC and shown on the clock of whoever has the page
// open: 23:36 UTC is 18:36 to someone in New York, and that is what they read.

const two = (n: number) => String(n).padStart(2, "0");

/** 2026-11-10 18:36:04, local time. */
export function dateTime(at: number | string | null | undefined): string {
  if (at === null || at === undefined) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${timeOfDay(at)}`;
}

/** 18:36:04, local time. */
export function timeOfDay(at: number | string | null | undefined): string {
  if (at === null || at === undefined) return "—";
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? "—" : `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** How far this browser's clock is from UTC: "UTC−5", "UTC+5:30", "UTC". */
export function zoneLabel(at: Date = new Date()): string {
  const minutes = -at.getTimezoneOffset();
  if (!minutes) return "UTC";
  const m = Math.abs(minutes);
  return `UTC${minutes < 0 ? "−" : "+"}${Math.floor(m / 60)}${m % 60 ? `:${two(m % 60)}` : ""}`;
}

/** This browser's time zone by name, "Europe/London", for the server to group days by. */
export function timeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
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
