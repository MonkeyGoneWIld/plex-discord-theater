import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { getSessionToken } from "../lib/api";

const MAX_RECONNECT_ATTEMPTS = 20;

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
  /** Timestamp of the last host command — used to detect stale state on reconnect */
  lastCommandAt: number;
  /** True if the WebSocket closed due to authentication failure (code 1008) */
  authFailed: boolean;
  /** True if max reconnect attempts exhausted */
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
  /** A co-host asked for a subtitle change. Only the host acts on it, since
   *  subtitles are burned in and applying one restarts the transcode. `seq`
   *  makes repeat requests for the same track fire the effect again. */
  subtitleRequest: { partId: number; subtitleStreamID: number; seq: number } | null;
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
  sendPlay: (ratingKey: string, title: string, subtitles: boolean, hlsSessionId: string) => void;
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
  sendSetSubtitle: (partId: number, subtitleStreamID: number) => void;
  /** Co-host: ask the host to advance to the next item. */
  sendPlayItem: (ratingKey: string) => void;
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
  lastCommandAt: 0,
  authFailed: false,
  reconnectFailed: false,
  browseContext: null,
  queue: [],
  participants: [],
  isCoHost: false,
  subtitleRequest: null,
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

  const send = useCallback((msg: object) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(msg));
    }
  }, []);

  const actions: SyncActions = useMemo(
    () => ({
      sendPlay: (ratingKey: string, title: string, subtitles: boolean, hlsSessionId: string) =>
        send({ type: "play", ratingKey, title, subtitles, hlsSessionId }),
      sendPause: (position: number) => send({ type: "pause", position }),
      sendResume: (position: number) => send({ type: "resume", position }),
      sendSeek: (position: number) => send({ type: "seek", position }),
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
      sendSetSubtitle: (partId: number, subtitleStreamID: number) =>
        send({ type: "set-subtitle", partId, subtitleStreamID }),
      sendPlayItem: (ratingKey: string) => send({ type: "play-item", ratingKey }),
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
            username,
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
              commandSeq: prev.commandSeq + 1,
              lastCommandAt: (msg.lastCommandAt as number) ?? Date.now(),
              browseContext: (msg.browseContext as string) || null,
              queue: (msg.queue as QueueItem[]) || [],
              hostUsername: (msg.hostUsername as string) || prev.hostUsername,
              participants: (msg.participants as Participant[]) || [],
              isCoHost:
                ((msg.participants as Participant[]) || []).find((p) => p.userId === userId)
                  ?.isCoHost ?? false,
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
          case "set-subtitle":
            setState((prev) => ({
              ...prev,
              subtitleRequest: {
                partId: msg.partId as number,
                subtitleStreamID: msg.subtitleStreamID as number,
                seq: (prev.subtitleRequest?.seq ?? 0) + 1,
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
              playing: true,
              position: 0,
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
            }));
            break;
          case "stop":
            setState((prev) => ({
              ...prev,
              ratingKey: null,
              title: null,
              hlsSessionId: null,
              playing: false,
              position: 0,
              commandSeq: prev.commandSeq + 1,
              browseContext: null,
              queue: [],
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
          case "suggestion":
            setState((prev) => ({
              ...prev,
              suggestions: [...prev.suggestions, msg.item as SuggestionItem],
            }));
            break;
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

        // Reconnect with exponential backoff
        const delay = Math.min(1000 * Math.pow(2, retryRef.current), 15000);
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
  }, [enabled, instanceId, userId, username]);

  return { state, actions };
}
