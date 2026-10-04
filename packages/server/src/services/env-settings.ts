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
