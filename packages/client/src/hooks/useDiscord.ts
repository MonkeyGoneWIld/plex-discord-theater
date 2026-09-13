import { useState, useEffect, useRef, useCallback } from "react";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { apiPost, setSessionToken } from "../lib/api";
import { initClientLogging, logEvent } from "../lib/log";
import { createPresenceSender } from "../lib/presence";
import type { PresenceInput, PresenceSender } from "../lib/presence";

interface DiscordState {
  isReady: boolean;
  isHost: boolean;
  userId: string | null;
  username: string | null;
  instanceId: string | null;
  error: string | null;
  /** Whether this launch context has a channel to invite into — false in a DM
   *  call, where there is no channel invite to create. */
  canInvite: boolean;
  /**
   * Open Discord's invite dialog for the channel this activity is running in.
   *
   * `openInviteDialog`, deliberately, and NOT `shareLink`. That distinction is
   * the whole behaviour of this button:
   *
   *   openInviteDialog creates an invite **to this voice channel**. Whoever
   *   accepts is taken to the channel, and joins *this* activity instance —
   *   the same room, the same film, in sync.
   *
   *   shareLink shares a URL to the activity. Opening it launches the activity
   *   wherever the recipient happens to be, which is a *different* instance:
   *   they end up alone in their own watch party wondering where everyone is.
   *
   * This was briefly changed to shareLink to get a nicer-looking picker, and
   * that broke the only thing the button is for. Discord's dialog lists what
   * Discord chooses to list; we don't control it, and it isn't worth the
   * feature.
   */
  openInvite: () => Promise<InviteResult>;
  /** Open a URL outside Discord's embedded Activity webview. */
  openExternalLink: (url: string) => Promise<boolean>;
  /** Update this user's optional, room-centric rich presence. */
  setPresence: (input: PresenceInput) => void;
}

/**
 * What came of asking Discord to open the invite dialog.
 *
 * Two cases, not three: `openInviteDialog` tells us whether the dialog *opened*
 * and nothing about what the user then did with it, so there is no "they sent
 * it" to report and nothing to say on the happy path.
 */
export type InviteResult =
  /** The dialog opened. Whether they actually invited anyone is Discord's business. */
  | "opened"
  /** No channel, or no permission to create an invite — worth a quiet note. */
  | "unavailable";

/**
 * The Discord application id.
 *
 * Injected into the page by the server (see its index.html handler), so one
 * built image serves every deployment. Falls back to the build-time value,
 * which is how `npm run dev` works — there Vite serves the page and nothing
 * injects anything.
 */
const CLIENT_ID =
  (globalThis as { __DISCORD_CLIENT_ID__?: string }).__DISCORD_CLIENT_ID__ ||
  (import.meta.env.VITE_DISCORD_CLIENT_ID as string);

const BROWSING_PRESENCE: PresenceInput = {
  ratingKey: null,
  title: null,
  playing: false,
  position: 0,
  durationMs: null,
  timelineVersion: 0,
  participantCount: 0,
  connected: true,
  shareDetails: false,
  artworkUrl: null,
};

export function useDiscord(): DiscordState {
  const [state, setState] = useState<
    Omit<DiscordState, "openInvite" | "openExternalLink" | "setPresence" | "canInvite"> & { canInvite: boolean }
  >({
    isReady: false,
    isHost: false,
    userId: null,
    username: null,
    instanceId: null,
    error: null,
    canInvite: false,
  });
  const initRef = useRef(false);
  // Held so the invite command can be issued long after init — the SDK is
  // otherwise scoped to the effect below.
  const sdkRef = useRef<DiscordSDK | null>(null);

  const presenceInputRef = useRef<PresenceInput | null>(null);
  const presenceSenderRef = useRef<PresenceSender | null>(null);
  const presenceReadyRef = useRef(false);
  const mountedRef = useRef(false);
  /** Whether the authorize call that ran actually included the presence scope. */
  const presenceAllowedRef = useRef(false);

  const setPresence = useCallback((input: PresenceInput): void => {
    // App input can arrive while authorization is pending. Never overwrite it
    // with the generic startup presence once the SDK becomes ready.
    presenceInputRef.current = input;
    presenceSenderRef.current?.update(input);
  }, []);

  const openInvite = useCallback(async (): Promise<InviteResult> => {
    const sdk = sdkRef.current;
    if (!sdk) return "unavailable";
    try {
      await sdk.commands.openInviteDialog();
      logEvent("Discord", "invite dialog opened", {});
      return "opened";
    } catch (err) {
      // Thrown for a context with nothing to invite to (a DM call) and when the
      // user lacks Create Invite in the channel. Neither is our failure, and
      // neither is worth an error banner — the caller shows a quiet note.
      logEvent("Discord", "invite dialog unavailable", {
        reason: err instanceof Error ? err.message : String(err),
      });
      return "unavailable";
    }
  }, []);

  const openExternalLink = useCallback(async (url: string): Promise<boolean> => {
    const sdk = sdkRef.current;
    if (!sdk) return false;
    try {
      const result = await sdk.commands.openExternalLink({ url });
      const opened = result?.opened !== false;
      logEvent("Discord", "external link requested", { opened, host: new URL(url).host });
      return opened;
    } catch (err) {
      logEvent("Discord", "external link unavailable", {
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const startPresence = () => {
      const sdk = sdkRef.current;
      if (!mountedRef.current || !sdk || !presenceReadyRef.current ||
          !presenceAllowedRef.current || presenceSenderRef.current) return;
      presenceSenderRef.current = createPresenceSender(
        (payload) => sdk.commands.setActivity(payload),
        (failure) => {
          // Discord error messages may echo a rejected payload. Log only the
          // classified error code, never titles, artwork URLs, or timestamps.
          logEvent("Discord", "presence delivery stopped", { ...failure });
        },
      );
      presenceSenderRef.current.update(presenceInputRef.current ?? BROWSING_PRESENCE);
    };
    const cleanup = () => {
      mountedRef.current = false;
      presenceSenderRef.current?.dispose();
      presenceSenderRef.current = null;
    };
    if (initRef.current) {
      // Strict Mode replays effects without replaying authorization. Recreate
      // only the disposable sender if initialization has already finished.
      startPresence();
      return cleanup;
    }
    initRef.current = true;

    const init = async () => {
      try {
        const sdk = new DiscordSDK(CLIENT_ID);
        sdkRef.current = sdk;

        await sdk.ready();

        // identify — who the user is, bound to their session server-side.
        // guilds  — which servers they are in, checked against
        //           ALLOWED_GUILD_IDS at /register (see routes/discord.ts).
        // rpc.activities.write — required by setActivity. RPC error 4006 is
        // INVALID_PERMISSIONS (also returned before authentication).
        //
        // Requested as an extra rather than assumed, because an app that hasn't
        // been granted it would fail `authorize` outright — and a broken launch
        // is a far worse outcome than a stale presence line. The fallback below
        // is what makes asking safe.
        const FULL_SCOPES = ["identify", "guilds", "rpc.activities.write"] as const;
        const MINIMAL_SCOPES = ["identify", "guilds"] as const;
        let code: string;
        try {
          ({ code } = await sdk.commands.authorize({
            client_id: CLIENT_ID,
            response_type: "code",
            state: "",
            prompt: "none",
            scope: [...FULL_SCOPES],
          }));
          presenceAllowedRef.current = true;
        } catch (err) {
          logEvent("Discord", "authorize without presence scope", {
            reason: err instanceof Error ? err.message : String(err),
          });
          ({ code } = await sdk.commands.authorize({
            client_id: CLIENT_ID,
            response_type: "code",
            state: "",
            prompt: "none",
            scope: [...MINIMAL_SCOPES],
          }));
          presenceAllowedRef.current = false;
        }

        const { access_token, session_token } = await apiPost<{
          access_token: string;
          session_token: string;
        }>("/api/token", { code });
        if (session_token) {
          setSessionToken(session_token);
          // Only now can shipped logs authenticate, so this is the earliest
          // point worth starting the uploader.
          initClientLogging();
        } else {
          console.warn("No session token received from server");
        }

        const auth = await sdk.commands.authenticate({ access_token });
        const user = auth.user;

        const { isHost } = await apiPost<{ isHost: boolean; hostId: string }>(
          "/api/register",
          {
            instanceId: sdk.instanceId,
            userId: user.id,
            // null in a DM/group-DM voice call — there's no guild there.
            guildId: sdk.guildId ?? null,
            // Scopes "one active party" to this specific voice/DM channel
            // instead of the whole server, so multiple voice channels in
            // the same server can run independent watch parties.
            channelId: sdk.channelId ?? null,
          },
        );

        // Identity for every later log line — one file holds the whole room, so
        // without this there's no way to tell whose client made a call.
        logEvent("Discord", "joined", {
          userId: user.id,
          username: user.username,
          isHost,
          instanceId: sdk.instanceId,
          channelId: sdk.channelId ?? "none",
        });

        // Presence remains optional; a missing scope cannot prevent joining.
        presenceReadyRef.current = true;
        startPresence();
        if (!mountedRef.current) return;

        setState({
          isReady: true,
          isHost,
          userId: user.id,
          username: user.username,
          instanceId: sdk.instanceId,
          error: null,
          // guildId, not channelId. A (G)DM call *has* a channel id, so that
          // test passed there and offered a button that could only fail — the
          // SDK documents openInviteDialog as throwing INVALID_CHANNEL without
          // a guild. Hidden is better than present and broken.
          canInvite: sdk.guildId != null,
        });
      } catch (err) {
        if (!mountedRef.current) return;
        console.error("Discord SDK init failed:", JSON.stringify(err, null, 2), err);
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        setState((prev) => ({
          ...prev,
          error: message,
        }));
      }
    };

    init();
    return cleanup;
  }, []);

  return { ...state, openInvite, openExternalLink, setPresence };
}
