/**
 * A numeric setting from the environment, or `fallback` when it is unset,
 * empty, not a number, or below `min`.
 *
 * Empty is the case that matters. The bundled docker-compose.yml passes
 * optional settings through as `NAME=${NAME}`, so one left out of .env arrives
 * as "" rather than undefined — and `??` only falls back on undefined, while
 * `Number("")` is 0. Read that way, an unset setting quietly becomes 0.
 */
export function numberSetting(name: string, fallback: number, min = 0): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? value : fallback;
}

const SIZE_UNITS = { K: 1024, M: 1024 ** 2, G: 1024 ** 3, T: 1024 ** 4 } as const;

/**
 * A size setting, in bytes. A number with an optional unit — K, M, G or T,
 * with or without a trailing B, in any case and with or without a space:
 * "10G", "500MB", "1.5 t". A bare number is read in `bareUnit`, so a setting
 * that used to take plain megabytes still reads its old values the same way.
 * Falls back like numberSetting when unset, empty, unparseable or not above 0.
 */
export function sizeSetting(name: string, fallbackBytes: number, bareUnit: keyof typeof SIZE_UNITS = "M"): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallbackBytes;
  const match = /^(\d+(?:\.\d+)?)\s*([KMGT])?B?$/i.exec(raw);
  if (!match) return fallbackBytes;
  const unit = (match[2]?.toUpperCase() ?? bareUnit) as keyof typeof SIZE_UNITS;
  const bytes = Math.round(Number(match[1]) * SIZE_UNITS[unit]);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : fallbackBytes;
}
