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

/** 2026-11-10 6:36:04 PM, local time. */
export function dateTime(at: number | string | null | undefined): string {
  if (at === null || at === undefined) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${timeOfDay(at)}`;
}

/** The hour on a 12-hour clock, and AM or PM: 0 is 12 AM, 12 is 12 PM. */
const twelve = (h: number): [number, string] => [h % 12 || 12, h < 12 ? "AM" : "PM"];

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "17 Nov, 6:36 PM", local time: a moment in a period of days. */
export function dayTime(at: number | string | null | undefined, now = Date.now()): string {
  const day = dayDate(at, now);
  return day === "—" ? day : `${day}, ${shortTime(at)}`;
}

/** "17 Nov", or "17 Nov 2025" in another year: a day. */
export function dayDate(at: number | string | null | undefined, now = Date.now()): string {
  if (at === null || at === undefined) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  const year = d.getFullYear() === new Date(now).getFullYear() ? "" : ` ${d.getFullYear()}`;
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${year}`;
}

/** 16 h 52 min, 45 min, 40 s: a total of time, as a person's watch time. */
export function hoursMinutes(totalS: number): string {
  const s = Math.max(0, Math.round(totalS));
  if (s < 60) return `${s} s`;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : `${m} min`;
}

/** 850 ms, 1.4 s, 12 s, 1:04, 1:02:05: how long something took. */
export function duration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1).replace(/\.0$/, "")} s`;
  if (ms < 60_000) return `${Math.round(ms / 1000)} s`;
  return clock(Math.round(ms / 1000));
}

/** A buffer in whole seconds, however long: "149 s", never "2:29". */
export function seconds(s: number): string {
  return `${Math.round(s)} s`;
}

/** 6:36:04 PM, local time. */
export function timeOfDay(at: number | string | null | undefined): string {
  if (at === null || at === undefined) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  const [h, half] = twelve(d.getHours());
  return `${h}:${two(d.getMinutes())}:${two(d.getSeconds())} ${half}`;
}

/** 6:36 PM, local time: a chart axis's time. */
export function shortTime(at: number | string | null | undefined): string {
  if (at === null || at === undefined) return "—";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "—";
  const [h, half] = twelve(d.getHours());
  return `${h}:${two(d.getMinutes())} ${half}`;
}

/** An hour of the day, 0–23, as "12 AM", "6 PM". */
export function hourLabel(hour: number): string {
  const [h, half] = twelve(((hour % 24) + 24) % 24);
  return `${h} ${half}`;
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
