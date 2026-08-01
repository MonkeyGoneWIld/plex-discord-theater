import { useState, useEffect, useRef, useCallback } from "react";
import { DiscordSDK } from "@discord/embedded-app-sdk";
import { apiPost, setSessionToken } from "../lib/api";
import { initClientLogging, logEvent } from "../lib/log";

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
  /**
   * Update what Discord shows this user as doing.
   *
   * Pass the title while something is playing, or null while browsing. Discord
   * renders it under the activity name in the member list and on the profile,
   * which for a watch-together activity is most of the point — and it was set
   * once at startup and then never again, so it said "Browsing the library" for
   * the whole session including two hours into a film.
   */
  setPresence: (nowPlaying: string | null) => void;
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

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID as string;

export function useDiscord(): DiscordState {
  const [state, setState] = useState<
    Omit<DiscordState, "openInvite" | "setPresence" | "canInvite"> & { canInvite: boolean }
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

  // Last presence we sent, so repeated renders with the same title don't turn
  // into a stream of RPC calls.
  const presenceRef = useRef<string | null>(null);
  const presenceReadyRef = useRef(false);
  /** Whether the authorize call that ran actually included the presence scope. */
  const presenceAllowedRef = useRef(false);
  /** Set after the first rejection, so a scope Discord won't grant produces one
   *  line rather than one per title change for the rest of the session. */
  const presenceDeadRef = useRef(false);

  const setPresence = useCallback((nowPlaying: string | null): void => {
    const sdk = sdkRef.current;
    if (!sdk || !presenceReadyRef.current) return;
    if (!presenceAllowedRef.current || presenceDeadRef.current) return;
    const state = nowPlaying ? `Watching ${nowPlaying}` : "Browsing the library";
    if (presenceRef.current === state) return;
    presenceRef.current = state;
    // type 3 = Watching (same enum as bot Gateway presences).
    sdk.commands
      .setActivity({
        activity: {
          type: 3,
          details: "Watch Together",
          // Discord caps this at 128 characters and rejects the whole payload
          // over it, which a long "Show — S1E1 · Episode Title" can reach.
          state: state.slice(0, 128),
        },
      })
      .catch((err: unknown) => {
        // Presence is decoration; a rejection must never surface to the user.
        // Latched, because the realistic cause is a scope this app will never
        // be granted, and repeating that on every title change buries the log
        // in a line that says the same thing each time. `[object Object]` is
        // what the old formatting produced for Discord's error shape, which
        // meant the one useful detail — the code — never made it in.
        presenceDeadRef.current = true;
        logEvent("Discord", "presence disabled after rejection", {
          reason:
            err instanceof Error
              ? err.message
              : (() => { try { return JSON.stringify(err); } catch { return String(err); } })(),
        });
      });
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

  useEffect(() => {
    if (initRef.current) return;
    initRef.current = true;

    const init = async () => {
      try {
        const sdk = new DiscordSDK(CLIENT_ID);
        sdkRef.current = sdk;

        await sdk.ready();

        // identify — who the user is, bound to their session server-side.
        // guilds  — which servers they are in, checked against
        //           ALLOWED_GUILD_IDS at /register (see routes/discord.ts).
        // rpc.activities.write — what setActivity needs. Without it every
        //           presence update is rejected with 4006 "Not authenticated or
        //           invalid scope", which is what was happening on every client
        //           in production: the member list said "Browsing the library"
        //           for the whole session, two hours into a film.
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

        // Rich Presence: without this, Discord shows members as "Playing"
        // this Activity by default. type: 3 = Watching (same enum as bot
        // Gateway presences: 0 Playing, 1 Streaming, 2 Listening, 3 Watching).
        // Kept current from here on by setPresence — see App.tsx.
        presenceReadyRef.current = true;
        setPresence(null);

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
        console.error("Discord SDK init failed:", JSON.stringify(err, null, 2), err);
        const message = err instanceof Error ? err.message : JSON.stringify(err);
        setState((prev) => ({
          ...prev,
          error: message,
        }));
      }
    };

    init();
  }, []);

  return { ...state, openInvite, setPresence };
}
