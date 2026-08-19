import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getSessionToken } from "../lib/api";

const MAX_RECONNECT_ATTEMPTS = 20;
/** Suggestions held for the host. Bounded so a viewer holding the button down
 *  can't grow this without limit on someone else's machine. */
const MAX_SUGGESTIONS = 20;

export interface QueueItem {
  ratingKey: string;
  title: string;
  type: string;
  thumb: string | null;
  subtitles: boolean;
  parentTitle?: string;
  /** Show name on server-sourced items (auto-resolved next episodes). Client-built
   *  items put the show in parentTitle instead — see lib/format.ts. */
  showTitle?: string;
  parentIndex?: number;
  index?: number;
  year?: number;
}

export interface SuggestionItem {
  ratingKey: string;
  title: string;
  type: string;
  thumb: string | null;
  year?: number;
  /** Episode context, so the host sees "Show — S1E4 · Name" rather than a bare
   *  episode title. Without these an episode suggestion is unidentifiable. */
  showTitle?: string;
  parentTitle?: string;
  parentIndex?: number;
  index?: number;
  /** Set by the server from the sender's session — the client never sends this itself. */
  fromUsername?: string;
}

/**
 * The stream this client is on, and the tracks it is for.
 *
 * A room is one timeline with a transcode per set of tracks anyone has chosen.
 * Everyone starts on the host's; picking different audio or subtitles moves you
 * onto the stream that serves them, or starts one if nobody has it.
 *
 * `isOwner` means this client drives that transcode — starts it, restarts it for
 * a seek it can't serve in place, and keeps it alive. It says nothing about
 * control of the room.
 */
export interface StreamVariant {
  variantKey: string;
  audioStreamId: number;
  subtitleStreamId: number;
  /** Null when the stream has no transcode yet, which is the owner's cue to
   *  start one and report it back with sendVariantSession. */
  hlsSessionId: string | null;
  sessionOffset: number;
  isOwner: boolean;
}

export interface SyncState {
  connected: boolean;
  ratingKey: string | null;
  title: string | null;
  subtitles: boolean;
  playing: boolean;
  position: number;
  hostDisconnected: boolean;
  hlsSessionId: string | null;
  /** null = no override (use initial value from useDiscord), true = promoted to host by server */
  isHost: boolean | null;
  /** Display name of the current host — shown to viewers so they know who's hosting.
   *  Requires the server to include `hostUsername` in "state", "host-promoted",
   *  and "host-changed" messages. */
  hostUsername: string | null;
  /** Increments only on explicit commands (play/pause/resume/seek), not heartbeats */
  commandSeq: number;
  /**
   * Increments each time the server sends a full room snapshot — i.e. on every
   * (re)join.
   *
   * A snapshot bumps `commandSeq` too, because a viewer has to act on it. The
   * host must not: it *is* the authority for position and play state, and its
   * own last report is what the snapshot echoes back. After a socket blip that
   * echo is stale — up to a heartbeat old, or worse if the host paused while
   * disconnected and the room never heard — and applying it un-paused the host
   * or dragged its playhead backwards. This lets the player tell the two apart.
   */
  stateSeq: number;
  /**
   * Offset the current transcode was started at. Nothing before it exists, so a
   * seek behind it needs a restart rather than an in-place jump — which a client
   * that didn't start the session (a joiner, or a promoted host) has no other
   * way to know.
   */
  sessionOffset: number;
  /** Increments each time the host issues a seek — lets viewers surface a
   *  transient "seeking" status without inferring it from position jumps. */
  seekSeq: number;
  /** Timestamp of the last host command — used to detect stale state on reconnect */
  lastCommandAt: number;
  /** True if the WebSocket closed due to authentication failure (code 1008) */
  authFailed: boolean;
  /** True if max reconnect attempts exhausted. `retryConnection` clears it. */
  reconnectFailed: boolean;
  /** What the host is currently browsing, or null if playing/idle */
  browseContext: string | null;
  queue: QueueItem[];
  /** Titles viewers have suggested — populated on the host's client only.
   *  Requires the server to relay "suggest" messages from a viewer to the
   *  host as a "suggestion" message: { type: "suggestion", item: {...} }. */
  suggestions: SuggestionItem[];
  /** Everyone currently in the room, with their roles. Refreshed by the server
   *  on join, leave, and any role change. */
  participants: Participant[];
  /** Whether *this* client is a co-host (transport control, granted by the host).
   *  Always false for the host, whose rights already supersede it. */
  isCoHost: boolean;
  /**
   * Which stream this client should be playing. Null before playback starts.
   *
   * `seq` increments on every assignment, including one that repoints the same
   * variant at a new session after its owner restarted the transcode — the
   * player has to act on that even though nothing else about it changed.
   */
  variant: (StreamVariant & { seq: number }) | null;
  /** A co-host asked to advance to the next item. Only the host acts on it,
   *  since starting a title is host-only. `seq` re-fires the effect on repeats. */
  playItemRequest: { ratingKey: string; seq: number } | null;
}

export interface Participant {
  userId: string;
  username: string | null;
  isHost: boolean;
  isCoHost: boolean;
}

export interface SyncActions {
  /**
   * `position` is where the room should be — normally the offset the transcode
   * was started at (resume or seek-restart), so viewers land there rather than
   * at 0:00. Omit for a plain start.
   *
   * `sessionOffset` is where the transcode itself begins, which is usually the
   * same number and isn't when the host re-announces a running session it has
   * already played some of. They are separated because the two mean different
   * things to a client that didn't start the session: one is where to seek to,
   * the other is the floor below which no segments exist.
   */
  sendPlay: (
    ratingKey: string,
    title: string,
    subtitles: boolean,
    hlsSessionId: string,
    position?: number,
    sessionOffset?: number,
    /** The tracks this stream is for — it becomes the room's default variant,
     *  and the one everybody who hasn't chosen otherwise watches. */
    audioStreamId?: number,
    subtitleStreamId?: number,
  ) => void;
  sendPause: (position: number) => void;
  sendResume: (position: number) => void;
  sendSeek: (position: number) => void;
  sendStop: () => void;
  sendHeartbeat: (position: number, playing: boolean) => void;
  sendBrowse: (context: string) => void;
  sendQueueAdd: (item: QueueItem) => void;
  sendQueueRemove: (ratingKey: string) => void;
  sendQueueClear: () => void;
  sendQueueReorder: (queue: QueueItem[]) => void;
  /** Viewer → host: suggest a title. No-op (safe to call) for the host. */
  sendSuggest: (item: SuggestionItem) => void;
  /** Host: dismiss a suggestion from the list once seen/handled. */
  sendDismissSuggestion: (ratingKey: string) => void;
  /** Host: hand the host role to someone else. The sender drops to a plain viewer. */
  sendPromoteHost: (userId: string) => void;
  /** Host: grant or revoke transport control for a viewer. */
  sendSetCoHost: (userId: string, value: boolean) => void;
  /** Host or co-host: request a subtitle track. The host applies it. */
  /**
   * "Put me on these tracks."
   *
   * Anyone may call it. The server decides the scope: the host's choice carries
   * to everyone watching the host's stream, anyone else's moves only them. The
   * answer comes back as a `variant`.
   */
  sendSetTracks: (audioStreamId: number, subtitleStreamId: number) => void;
  /** Stream owner → room: the transcode I just brought up for my variant. */
  sendVariantSession: (hlsSessionId: string, sessionOffset: number) => void;
  /** Co-host: ask the host to advance to the next item. */
  sendPlayItem: (ratingKey: string) => void;
  /**
   * Tell the room whether this client has the player open.
   *
   * Only used to order host succession — someone watching inherits before
   * someone browsing, because a host who isn't in the player can't pause, seek
   * or answer a stall, and their next move usually ends the stream for
   * everyone. Not reflected in the roster.
   */
  sendWatching: (value: boolean) => void;
  /**
   * Start reconnecting again after the automatic attempts were exhausted.
   *
   * Without this, twenty failed retries left the app permanently showing
   * "please close and restart the activity" — which, in a Discord Activity,
   * means leaving the call and coming back. A network that recovers a minute
   * later had no way to be noticed.
   */
  retryConnection: () => void;
}

interface UseSyncOptions {
  instanceId: string | null;
  userId: string | null;
  username: string | null;
  enabled: boolean;
}

const INITIAL_STATE: SyncState = {
  connected: false,
  ratingKey: null,
  title: null,
  subtitles: false,
  playing: false,
  position: 0,
  hostDisconnected: false,
  hlsSessionId: null,
  isHost: null,
  hostUsername: null,
  suggestions: [],
  commandSeq: 0,
  stateSeq: 0,
  sessionOffset: 0,
  seekSeq: 0,
  lastCommandAt: 0,
  authFailed: false,
  reconnectFailed: false,
  browseContext: null,
  queue: [],
  participants: [],
  isCoHost: false,
  variant: null,
  playItemRequest: null,
};

export function useSync({ instanceId, userId, username, enabled }: UseSyncOptions): {
  state: SyncState;
  actions: SyncActions;
} {
  const [state, setState] = useState<SyncState>(INITIAL_STATE);
  const wsRef = useRef<WebSocket | null>(null);
  const retryRef = useRef(0);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Bumped by retryConnection. It is a dependency of the connect effect, so a
  // bump tears the old socket down and starts the whole sequence again from a
  // clean attempt count — which is exactly what a manual retry should mean.
  const [reconnectNonce, setReconnectNonce] = useState(0);
  // Read at join time rather than depended on. A change here is cosmetic — it is
  // the display name in the roster — and having it in the effect's deps meant
  // any change tore the socket down mid-party and rejoined, which evicts the old
  // connection and re-broadcasts the roster for nothing.
  const usernameRef = useRef(username);
  usernameRef.current = username;

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const actions: SyncActions = useMemo(
    () => ({
      // ── Transport: send, and apply to ourselves ─────────────────
      //
      // The server excludes the sender from its broadcasts, so a client never
      // hears its own commands back. sendStop has always compensated for that
      // (see its note below); the rest did not, and `playing` in particular
      // stayed at its `false` initial value on whoever was hosting, for the
      // whole session — the host announces "play" and is the one client not
      // told about it.
      //
      // That was invisible until someone else sent a command. Player.tsx
      // applies room state to the element on every command it receives:
      //
      //     if (syncState.playing && video.paused) video.play();
      //     else if (!syncState.playing && !video.paused) video.pause();
      //
      // so the moment a co-host seeked, the host — believing the room to be
      // paused, because nothing had ever told it otherwise — paused itself,
      // while the co-host, who never paused anything, played on. Same for a
      // co-host's pause and resume: every one of them stopped the host.
      //
      // Optimistically applying what we just sent is the fix, and it is the
      // truthful thing to store: we know what we asked the room to do.
      sendPlay: (
        ratingKey: string,
        title: string,
        subtitles: boolean,
        hlsSessionId: string,
        position?: number,
        sessionOffset?: number,
        audioStreamId?: number,
        subtitleStreamId?: number,
      ) => {
        send({
          type: "play", ratingKey, title, subtitles, hlsSessionId, position, sessionOffset,
          audioStreamId, subtitleStreamId,
        });
        setState((prev) => ({
          ...prev,
          playing: true,
          position: position ?? 0,
          sessionOffset: sessionOffset ?? position ?? 0,
        }));
      },
      sendPause: (position: number) => {
        send({ type: "pause", position });
        setState((prev) => ({ ...prev, playing: false, position }));
      },
      sendResume: (position: number) => {
        send({ type: "resume", position });
        setState((prev) => ({ ...prev, playing: true, position }));
      },
      // Deliberately does not touch `playing`: a seek says where, not whether.
      sendSeek: (position: number) => {
        send({ type: "seek", position });
        setState((prev) => ({ ...prev, position }));
      },
      sendStop: () => {
        send({ type: "stop" });
        // Optimistically clear local playback state. The server excludes the
        // sender from the "stop" broadcast, so without this the stopping host
        // keeps a stale ratingKey and would look like a live stream to the
        // rejoin banner / host pull-in.
        setState((prev) => ({
          ...prev,
          ratingKey: null,
          title: null,
          hlsSessionId: null,
          playing: false,
          position: 0,
        }));
      },
      sendHeartbeat: (position: number, playing: boolean) =>
        send({ type: "heartbeat", position, playing }),
      sendBrowse: (context: string) => send({ type: "browse", context }),
      sendQueueAdd: (item: QueueItem) => send({ type: "queue-add", item }),
      sendQueueRemove: (ratingKey: string) => send({ type: "queue-remove", ratingKey }),
      sendQueueClear: () => send({ type: "queue-clear" }),
      sendQueueReorder: (queue: QueueItem[]) => send({ type: "queue-reorder", queue }),
      sendSuggest: (item: SuggestionItem) => send({ type: "suggest", item }),
      sendDismissSuggestion: (ratingKey: string) => send({ type: "suggest-dismiss", ratingKey }),
      sendPromoteHost: (targetUserId: string) => send({ type: "promote-host", userId: targetUserId }),
      sendSetCoHost: (targetUserId: string, value: boolean) =>
        send({ type: "set-cohost", userId: targetUserId, value }),
      sendSetTracks: (audioStreamId: number, subtitleStreamId: number) =>
        send({ type: "set-tracks", audioStreamId, subtitleStreamId }),
      sendVariantSession: (hlsSessionId: string, sessionOffset: number) =>
        send({ type: "variant-session", hlsSessionId, sessionOffset }),
      sendPlayItem: (ratingKey: string) => send({ type: "play-item", ratingKey }),
      sendWatching: (value: boolean) => send({ type: "watching", value }),
      retryConnection: () => {
        retryRef.current = 0;
        setState((prev) => ({ ...prev, reconnectFailed: false }));
        setReconnectNonce((n) => n + 1);
      },
    }),
    [send],
  );

  useEffect(() => {
    let active = true;

    if (!enabled || !instanceId || !userId) return;

    function connect() {
      const token = getSessionToken();
      if (!token) return;

      const protocol = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);
      wsRef.current = ws;

      ws.addEventListener("open", () => {
        if (!active) return;
        retryRef.current = 0;
        ws.send(
          JSON.stringify({
            type: "join",
            sessionToken: token,
            instanceId,
            userId,
            username: usernameRef.current,
          }),
        );
        setState((prev) => ({ ...prev, connected: true, hostDisconnected: false }));
      });

      ws.addEventListener("message", (event) => {
        if (!active) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data as string);
        } catch {
          return;
        }

        switch (msg.type) {
          case "state":
            setState((prev) => ({
              ...prev,
              ratingKey: (msg.ratingKey as string) || null,
              title: (msg.title as string) || null,
              subtitles: Boolean(msg.subtitles),
              playing: Boolean(msg.playing),
              position: (msg.position as number) ?? 0,
              hlsSessionId: (msg.hlsSessionId as string) || null,
              sessionOffset: (msg.sessionOffset as number) ?? 0,
              commandSeq: prev.commandSeq + 1,
              stateSeq: prev.stateSeq + 1,
              lastCommandAt: (msg.lastCommandAt as number) ?? Date.now(),
              browseContext: (msg.browseContext as string) || null,
              queue: (msg.queue as QueueItem[]) || [],
              // The stream a joiner lands on — the host's. Absent from an older
              // server, in which case the player falls back to hlsSessionId.
              variant: msg.variant
                ? {
                    ...(msg.variant as Omit<StreamVariant, "isOwner"> & { isOwner: boolean }),
                    seq: (prev.variant?.seq ?? 0) + 1,
                  }
                : prev.variant,
              hostUsername: (msg.hostUsername as string) || prev.hostUsername,
              participants: (msg.participants as Participant[]) || [],
              isCoHost:
                ((msg.participants as Participant[]) || []).find((p) => p.userId === userId)
                  ?.isCoHost ?? false,
              // Taken from the roster for the same reason isCoHost is. Without
              // it a client that reconnects after being promoted — its socket
              // blipped at the same moment the previous host's dropped — is
              // told it is the host by the roster and ignores it, then sits
              // there with no transport controls over a room it owns.
              isHost:
                ((msg.participants as Participant[]) || []).find((p) => p.userId === userId)
                  ?.isHost ?? prev.isHost,
            }));
            break;
          case "participants": {
            const participants = (msg.participants as Participant[]) || [];
            setState((prev) => ({
              ...prev,
              participants,
              // Re-derive our own role from the roster so a revoked co-host
              // loses their controls without needing a separate message.
              isCoHost: participants.find((p) => p.userId === userId)?.isCoHost ?? false,
            }));
            break;
          }
          case "cohost-changed":
            setState((prev) => ({ ...prev, isCoHost: Boolean(msg.isCoHost) }));
            break;
          case "variant":
            // Which stream to play. Arrives on assignment and again whenever
            // its owner repoints it at a new transcode, so `seq` moves even
            // when nothing but the session id has.
            setState((prev) => ({
              ...prev,
              variant: {
                variantKey: msg.variantKey as string,
                audioStreamId: (msg.audioStreamId as number) ?? 0,
                subtitleStreamId: (msg.subtitleStreamId as number) ?? 0,
                hlsSessionId: (msg.hlsSessionId as string) || null,
                sessionOffset: (msg.sessionOffset as number) ?? 0,
                isOwner: Boolean(msg.isOwner),
                seq: (prev.variant?.seq ?? 0) + 1,
              },
            }));
            break;
          case "play-item":
            setState((prev) => ({
              ...prev,
              playItemRequest: {
                ratingKey: msg.ratingKey as string,
                seq: (prev.playItemRequest?.seq ?? 0) + 1,
              },
            }));
            break;
          case "play":
            setState((prev) => ({
              ...prev,
              ratingKey: (msg.ratingKey as string) || null,
              title: (msg.title as string) || null,
              subtitles: Boolean(msg.subtitles),
              hlsSessionId: (msg.hlsSessionId as string) || null,
              sessionOffset: (msg.sessionOffset as number) ?? 0,
              playing: true,
              // Non-zero when the host resumed from history or restarted the
              // transcode at a seek target; 0 for a plain start.
              position: (msg.position as number) ?? 0,
              hostDisconnected: false,
              commandSeq: prev.commandSeq + 1,
              browseContext: null,
            }));
            break;
          case "pause":
            setState((prev) => ({
              ...prev,
              playing: false,
              position: (msg.position as number) ?? prev.position,
              commandSeq: prev.commandSeq + 1,
            }));
            break;
          case "resume":
            setState((prev) => ({
              ...prev,
              playing: true,
              position: (msg.position as number) ?? prev.position,
              commandSeq: prev.commandSeq + 1,
            }));
            break;
          case "seek":
            setState((prev) => ({
              ...prev,
              position: (msg.position as number) ?? prev.position,
              commandSeq: prev.commandSeq + 1,
              seekSeq: prev.seekSeq + 1,
            }));
            break;
          case "stop":
            setState((prev) => ({
              ...prev,
              ratingKey: null,
              title: null,
              hlsSessionId: null,
              sessionOffset: 0,
              playing: false,
              position: 0,
              commandSeq: prev.commandSeq + 1,
              browseContext: null,
              // `queue` is deliberately left alone — the server keeps it across
              // a stop now, and clearing it here would put this client out of
              // step with the room the moment anything was queued.
            }));
            break;
          case "heartbeat":
            // Only update position — no commandSeq bump, so drift correction won't fire
            setState((prev) => ({
              ...prev,
              position: (msg.position as number) ?? prev.position,
              playing: msg.playing !== false,
              // Self-heal: if our "what's playing" state was cleared (e.g. a stray
              // stop during a host handoff), recover it from the heartbeat so the
              // rejoin path works again. Only fill when missing, to avoid churn
              // and spurious re-navigation while already watching.
              ...(prev.ratingKey == null && msg.ratingKey
                ? {
                    ratingKey: msg.ratingKey as string,
                    title: (msg.title as string) || null,
                    subtitles: Boolean(msg.subtitles),
                    hlsSessionId: (msg.hlsSessionId as string) || null,
                    sessionOffset: (msg.sessionOffset as number) ?? 0,
                  }
                // The session id can go missing on its own — a stray stop, or a
                // heartbeat that arrived before the "play" that announced the
                // restart. Without it a viewer has nothing to attach hls.js to
                // and sits on black with the room playing around them.
                : prev.hlsSessionId == null && msg.hlsSessionId
                  ? {
                      hlsSessionId: msg.hlsSessionId as string,
                      sessionOffset: (msg.sessionOffset as number) ?? prev.sessionOffset,
                    }
                  : {}),
            }));
            break;
          case "browse":
            setState((prev) => ({
              ...prev,
              browseContext: (msg.context as string) || null,
            }));
            break;
          case "host-info":
            setState((prev) => ({
              ...prev,
              hostUsername: (msg.hostUsername as string) || null,
            }));
            break;
          case "queue-updated":
            setState((prev) => ({
              ...prev,
              queue: (msg.queue as QueueItem[]) || [],
            }));
            break;
          case "suggestion": {
            const suggestion = msg.item as SuggestionItem | undefined;
            if (!suggestion?.ratingKey) break;
            setState((prev) => ({
              ...prev,
              // Oldest out once full, and never the same title twice — so a
              // viewer pressing Suggest repeatedly moves their entry rather
              // than stacking copies of it on the host's screen.
              suggestions: [
                ...prev.suggestions.filter((e) => e.ratingKey !== suggestion.ratingKey),
                suggestion,
              ].slice(-MAX_SUGGESTIONS),
            }));
            break;
          }
          case "suggestion-dismissed":
            setState((prev) => ({
              ...prev,
              suggestions: prev.suggestions.filter((s) => s.ratingKey !== msg.ratingKey),
            }));
            break;
          case "host-disconnected":
            setState((prev) => ({ ...prev, hostDisconnected: true }));
            break;
          case "host-reconnected":
            setState((prev) => ({ ...prev, hostDisconnected: false }));
            break;
          case "host-promoted":
            setState((prev) => ({
              ...prev,
              isHost: true,
              // Host rights supersede co-host; clear it so the UI doesn't
              // briefly show both badges before the roster arrives.
              isCoHost: false,
              hostDisconnected: false,
              hostUsername: (msg.hostUsername as string) || prev.hostUsername,
            }));
            break;
          case "host-changed":
            setState((prev) => ({
              ...prev,
              isHost: false,
              hostDisconnected: false,
              hostUsername: (msg.hostUsername as string) || prev.hostUsername,
            }));
            break;
        }
      });

      ws.addEventListener("close", (event) => {
        if (!active) return;
        wsRef.current = null;
        setState((prev) => ({ ...prev, connected: false }));

        // Close code 1008 = policy violation (auth failure) — don't retry,
        // the session token is invalid and reconnecting will loop forever
        if (event.code === 1008) {
          console.error("[Sync] Auth failure (1008), not reconnecting:", event.reason);
          setState((prev) => ({ ...prev, authFailed: true }));
          return;
        }

        // Cap reconnect attempts to prevent infinite loops
        if (retryRef.current >= MAX_RECONNECT_ATTEMPTS) {
          console.error("[Sync] Max reconnect attempts reached, giving up");
          setState((prev) => ({ ...prev, reconnectFailed: true }));
          return;
        }

        // Reconnect with exponential backoff, jittered.
        //
        // Without the jitter every client in the room retries on the same
        // schedule — they were all disconnected by the same event, so they all
        // start their timers within milliseconds of each other. The server then
        // takes the whole room's reconnects, joins and state sends in one burst
        // at 1s, again at 2s, again at 4s. Spreading each delay by ±25% costs
        // nothing and turns the burst back into arrivals.
        const base = Math.min(1000 * Math.pow(2, retryRef.current), 15000);
        const delay = Math.round(base * (0.75 + Math.random() * 0.5));
        retryRef.current++;
        retryTimerRef.current = setTimeout(connect, delay);
      });

      ws.addEventListener("error", () => {
        // close event will fire after this, triggering reconnect
      });
    }

    connect();

    return () => {
      active = false;
      if (retryTimerRef.current) {
        clearTimeout(retryTimerRef.current);
        retryTimerRef.current = null;
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, instanceId, userId, reconnectNonce]);

  return { state, actions };
}
