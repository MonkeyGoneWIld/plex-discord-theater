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
  /** Whether the SDK is up and the share command can be issued at all. */
  canInvite: boolean;
  /**
   * Open Discord's share modal — the friends-and-DMs picker — with `message`
   * alongside a link to this activity.
   *
   * This is `shareLink`, not `openInviteDialog`. The latter is documented as
   * "Channel Invite UI", and that is exactly what it gave: a list of text
   * channels and bots to post an invite into, when what anyone pressing an
   * Invite button in a watch party wants is to pick the person they are
   * watching with. shareLink is the one that opens the people picker, and it
   * needs no extra OAuth scope to do it.
   */
  shareActivity: (message: string) => Promise<ShareResult>;
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
 * What came of asking Discord to share.
 *
 * The three cases need different treatment and used to be collapsed into one
 * boolean: `shareLink` resolves `{ success: false }` when the user simply
 * closes the modal, which is not a failure and must not be reported as one.
 */
export type ShareResult =
  /** The user picked someone and Discord sent the link. */
  | "shared"
  /** The modal opened and the user closed it. Nothing to say about this. */
  | "dismissed"
  /** The command isn't available here — worth telling the user, quietly. */
  | "unavailable";

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID as string;

export function useDiscord(): DiscordState {
  const [state, setState] = useState<
    Omit<DiscordState, "shareActivity" | "setPresence" | "canInvite"> & { canInvite: boolean }
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

  const setPresence = useCallback((nowPlaying: string | null): void => {
    const sdk = sdkRef.current;
    if (!sdk || !presenceReadyRef.current) return;
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
        logEvent("Discord", "setActivity failed", {
          reason: err instanceof Error ? err.message : String(err),
        });
      });
  }, []);

  const shareActivity = useCallback(async (message: string): Promise<ShareResult> => {
    const sdk = sdkRef.current;
    if (!sdk) return "unavailable";
    try {
      // The people picker. Discord caps the message at 1000 characters and
      // rejects the whole call over it.
      const { success } = await sdk.commands.shareLink({ message: message.slice(0, 1000) });
      logEvent("Discord", success ? "activity link shared" : "share modal dismissed", {});
      return success ? "shared" : "dismissed";
    } catch (err) {
      // Older Discord clients predate SHARE_LINK. Falling back to the channel
      // invite dialog is not what anyone wants — it is the very thing this
      // replaced — but a button that does nothing at all is worse, and this
      // path only runs where the good one doesn't exist.
      logEvent("Discord", "shareLink unavailable, falling back to invite dialog", {
        reason: err instanceof Error ? err.message : String(err),
      });
      try {
        await sdk.commands.openInviteDialog();
        return "shared";
      } catch (fallbackErr) {
        logEvent("Discord", "invite dialog unavailable too", {
          reason: fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr),
        });
        return "unavailable";
      }
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

        const { code } = await sdk.commands.authorize({
          client_id: CLIENT_ID,
          response_type: "code",
          state: "",
          prompt: "none",
          // identify — who the user is, bound to their session server-side.
          // guilds  — which servers they are in, checked against
          //           ALLOWED_GUILD_IDS at /register (see routes/discord.ts).
          // Nothing else is asked for. "rpc.voice.read" used to be here and was
          // never read by anything; every unused scope is one more line on the
          // consent screen someone has to accept before they can watch.
          scope: ["identify", "guilds"],
        });

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
          // Not gated on sdk.channelId any more. That test was right for the
          // old channel-invite dialog, which genuinely had nothing to offer in
          // a DM call — but sharing a link to friends works from anywhere, and
          // hiding the button in a DM was hiding it from exactly the people
          // most likely to want it.
          canInvite: true,
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

  return { ...state, shareActivity, setPresence };
}
