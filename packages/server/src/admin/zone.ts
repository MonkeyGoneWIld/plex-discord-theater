/**
 * A time zone's clock, for the dashboard's statistics.
 *
 * Times are stored in UTC and stay so. The page a person opens shows them on
 * that person's clock, and the history is grouped by the day, hour and weekday
 * of that clock too: a film begun at 20:00 in New York was counted on the next
 * day, at 01:00, wherever the dashboard was opened.
 */
const DAY_MS = 86_400_000;

export interface ZoneClock {
  /** The zone's name, as "Europe/London". "UTC" when none was given, or what was given isn't one. */
  zone: string;
  /** How far its clock is ahead of UTC at an instant, in ms. */
  offset(at: number): number;
  /** The day an instant falls on by its clock, counted from 1 January 1970. */
  day(at: number): number;
  /** The instant a day begins on its clock. */
  dayStart(day: number): number;
  /**
   * SQL for a column of instants as the time on its clock, for instants from
   * `from` to `to`. A clock that changed in between, for summer time, is
   * followed across each change.
   */
  sql(column: string, from: number, to: number): string;
}

export function zoneClock(zone: unknown): ZoneClock {
  let fmt: Intl.DateTimeFormat | null = null;
  let name = "UTC";
  if (typeof zone === "string" && zone.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(zone)) {
    try {
      const f = new Intl.DateTimeFormat("en-US", {
        timeZone: zone, hourCycle: "h23",
        year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
      });
      name = f.resolvedOptions().timeZone;
      if (name !== "UTC") fmt = f;
    } catch {
      // Not a zone this server knows: UTC, as before.
    }
  }
  const offset = (at: number): number => {
    if (!fmt) return 0;
    const p: Record<string, number> = {};
    for (const part of fmt.formatToParts(at)) {
      if (part.type !== "literal") p[part.type] = Number(part.value);
    }
    return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(at / 1000) * 1000;
  };
  return {
    zone: name,
    offset,
    day: (at) => Math.floor((at + offset(at)) / DAY_MS),
    // The offset a day began with is the one in force just before it, which
    // the first pass finds unless the clock changed within those hours.
    dayStart: (day) => day * DAY_MS - offset(day * DAY_MS - offset(day * DAY_MS)),
    sql: (column, from, to) => {
      const changes: Array<{ until: number; off: number }> = [];
      let at = from;
      let off = offset(at);
      while (at < to) {
        const next = Math.min(at + DAY_MS, to);
        const then = offset(next);
        if (then !== off) {
          let lo = at;
          let hi = next;
          while (hi - lo > 1) {
            const mid = Math.floor((lo + hi) / 2);
            if (offset(mid) === off) lo = mid;
            else hi = mid;
          }
          changes.push({ until: hi, off });
          off = then;
        }
        at = next;
      }
      if (!changes.length) return off ? `(${column} + ${off})` : column;
      return `(${column} + CASE ${changes.map((c) => `WHEN ${column} < ${c.until} THEN ${c.off}`).join(" ")} ELSE ${off} END)`;
    },
  };
}
