import { RPCErrorCodes } from "@discord/embedded-app-sdk";

export interface PresenceInput {
  ratingKey: string | null;
  /** Already formatted by the caller, including episode information. */
  title: string | null;
  playing: boolean;
  /** Seconds, extrapolated to the time of this update by roomPositionNow. */
  position: number;
  durationMs: number | null;
  /** Changes on explicit playback commands, not on heartbeats. */
  timelineVersion: number;
  participantCount: number;
  /** The room is connected and its host is not disconnected. */
  connected: boolean;
  shareDetails: boolean;
  /** Only the public, opaque URL returned by /api/presence/artwork. */
  artworkUrl: string | null;
}

export interface PresenceActivity {
  type: 3;
  details: string;
  state: string;
  timestamps: { start: number; end: number } | null;
  assets: { large_image: string; large_text: string } | null;
}

/** Local timeline state; only activity crosses the Discord RPC boundary. */
export interface PresenceSnapshot {
  ratingKey: string | null;
  timelineVersion: number;
  activity: PresenceActivity;
}

const TEXT_LIMIT = 128;
const DRIFT_TOLERANCE_MS = 2_000;
const RETRY_DELAYS_MS = [1_000, 4_000] as const;
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function presenceText(value: string): string {
  if (value.length <= TEXT_LIMIT) return value;
  let end = 0;
  for (const part of graphemes.segment(value)) {
    const next = part.index + part.segment.length;
    if (next > TEXT_LIMIT - 1) break;
    end = next;
  }
  return `${value.slice(0, end)}…`;
}

/** Pure projection with a stable wall-clock anchor between playback commands. */
export function buildPresence(
  input: PresenceInput,
  nowMs: number,
  previous: PresenceSnapshot | null = null,
): PresenceSnapshot {
  const hasMedia = input.ratingKey !== null;
  const showMedia = input.connected && input.shareDetails && hasMedia && !!input.title;
  const ratingKey = showMedia ? input.ratingKey : null;
  const details = showMedia ? presenceText(input.title!) : "Watch Together";
  const status = !input.connected
    ? "Disconnected"
    : !hasMedia
      ? "Browsing the library"
      : !input.shareDetails
        ? "In a watch party"
        : showMedia
          ? `${input.playing ? "Watching" : "Paused"} ${input.title}`
          : input.playing ? "Playing" : "Paused";
  const count = Number.isFinite(input.participantCount)
    ? Math.max(0, Math.floor(input.participantCount))
    : 0;
  // A disconnected client's last room roster is no longer authoritative.
  // Keep the title in state as well as details: this was the pre-rich-presence
  // contract, and consumers that read only state otherwise lose media context.
  const state = input.connected && count > 0
    ? `${status} · ${count} ${count === 1 ? "person" : "people"} in room`
    : status;
  let timestamps: PresenceActivity["timestamps"] = null;
  if (
    showMedia && input.playing && Number.isFinite(nowMs) &&
    input.durationMs !== null && Number.isFinite(input.durationMs) && input.durationMs > 0 &&
    Number.isFinite(input.position)
  ) {
    const durationMs = Math.round(input.durationMs);
    const positionMs = Math.min(durationMs, Math.max(0, input.position * 1_000));
    const start = Math.round(nowMs - positionMs);
    const prior = previous?.activity.timestamps;
    if (
      prior && previous.ratingKey === ratingKey &&
      previous.timelineVersion === input.timelineVersion &&
      prior.end - prior.start === durationMs &&
      (Math.abs(prior.start - start) <= DRIFT_TOLERANCE_MS ||
        (positionMs === durationMs && nowMs >= prior.end))
    ) {
      timestamps = prior;
    } else {
      timestamps = { start, end: start + durationMs };
    }
  }
  return {
    ratingKey,
    timelineVersion: input.timelineVersion,
    activity: {
      type: 3,
      details,
      state: presenceText(state),
      // Null, not omission: paused/private/idle updates must clear old fields.
      timestamps,
      assets: showMedia && input.artworkUrl
        ? { large_image: input.artworkUrl, large_text: details }
        : null,
    },
  };
}

function samePresence(a: PresenceSnapshot | null, b: PresenceSnapshot): boolean {
  if (!a || a.ratingKey !== b.ratingKey) return false;
  const left = a.activity;
  const right = b.activity;
  return left.details === right.details && left.state === right.state &&
    left.timestamps?.start === right.timestamps?.start &&
    left.timestamps?.end === right.timestamps?.end &&
    left.assets?.large_image === right.assets?.large_image &&
    left.assets?.large_text === right.assets?.large_text;
}

export interface PresenceFailure {
  code: number | null;
  kind: "disabled" | "exhausted" | "rejected";
}

function errorCode(error: unknown): number | null {
  if (!error || typeof error !== "object" || !("code" in error)) return null;
  return typeof error.code === "number" && Number.isInteger(error.code) ? error.code : null;
}

function disablesPresence(code: number | null): boolean {
  // These are RPC command errors, not Gateway or RPC close codes. In particular,
  // 4008 is INVALID_ORIGIN, never a rate-limit response. 5000 is an OAuth2 error.
  // https://discord.com/developers/docs/topics/opcodes-and-status-codes#rpc
  return code === RPCErrorCodes.INVALID_PERMISSIONS || code === RPCErrorCodes.INVALID_COMMAND ||
    code === RPCErrorCodes.INVALID_CLIENTID || code === RPCErrorCodes.INVALID_ORIGIN ||
    code === RPCErrorCodes.INVALID_TOKEN || code === RPCErrorCodes.INVALID_USER || code === 5000;
}

function retryable(error: unknown, code: number | null): boolean {
  // 1000 is Discord's unknown RPC error: allow two recovery attempts, not a
  // permanent permission latch. Other numbered RPC rejections are not transient.
  return code === 1000 || (code === null && error instanceof Error &&
    (error.name === "NetworkError" || error.name === "TimeoutError"));
}

export interface PresenceSender {
  update: (input: PresenceInput) => void;
  dispose: () => void;
}

/**
 * One RPC at a time, with only the newest pending presence retained. The success
 * cache is separate from the desired state: a rejected command is never treated
 * as delivered. Repeated inputs cannot restart an exhausted retry sequence;
 * a genuinely different presence may try again. No heartbeat timer is needed.
 */
export function createPresenceSender(
  sendActivity: (payload: { activity: PresenceActivity }) => Promise<unknown>,
  onFailure?: (failure: PresenceFailure) => void,
): PresenceSender {
  let latest: PresenceSnapshot | null = null;
  let delivered: PresenceSnapshot | null = null;
  let inFlight = false;
  let stopped = false;
  let retryCount = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = async (): Promise<void> => {
    if (stopped || inFlight || timer !== null || !latest || samePresence(delivered, latest)) return;
    const attempted = latest;
    inFlight = true;
    try {
      await sendActivity({ activity: attempted.activity });
      if (stopped) return;
      delivered = attempted;
      retryCount = 0;
    } catch (error) {
      if (stopped) return;
      const code = errorCode(error);
      if (disablesPresence(code)) {
        stopped = true;
        onFailure?.({ code, kind: "disabled" });
      } else if (retryable(error, code) && retryCount < RETRY_DELAYS_MS.length) {
        timer = setTimeout(() => {
          timer = null;
          void flush();
        }, RETRY_DELAYS_MS[retryCount++]);
      } else {
        onFailure?.({ code, kind: retryable(error, code) ? "exhausted" : "rejected" });
        // A different input already queued behind this rejection still deserves
        // its own attempt. Otherwise wait for a future meaningful change.
        retryCount = 0;
        if (latest && samePresence(attempted, latest)) return;
      }
    } finally {
      inFlight = false;
    }
    void flush();
  };

  return {
    update(input) {
      if (stopped) return;
      const next = buildPresence(input, Date.now(), latest);
      const unchanged = samePresence(latest, next);
      // Even an unchanged payload can carry a new explicit-command version.
      latest = next;
      if (!unchanged) void flush();
    },
    dispose() {
      stopped = true;
      if (timer !== null) clearTimeout(timer);
      timer = null;
      latest = null;
      delivered = null;
    },
  };
}
