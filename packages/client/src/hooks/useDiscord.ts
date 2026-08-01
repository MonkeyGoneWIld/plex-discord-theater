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
  /** Whether this launch context can invite at all — false in a (G)DM call.
   *  Both routes need a guild: the SDK documents openInviteDialog as throwing
   *  INVALID_CHANNEL without one, and reading the call roster off a DM channel
   *  needs `dm_channels.read`, which Discord gates behind approval. */
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
   * that broke the only thing the button is for.
   *
   * Kept as the escape hatch behind our own picker (see listCallMembers), for
   * reaching anyone who isn't already in the voice channel. Discord's dialog
   * lists what Discord chooses to list — channels included — and we don't
   * control it, which is exactly why it is no longer the first thing offered.
   */
  openInvite: () => Promise<InviteResult>;
  /**
   * Everyone in this activity's voice channel, so we can offer a people-only
   * invite list instead of Discord's channel-invite dialog.
   *
   * Reads `voice_states` off getChannel, which needs only the `guilds` scope we
   * already hold. The obvious alternative — getRelationships, i.e. the actual
   * friend list — needs `relationships.read`, which is part of Discord's Social
   * SDK and gated behind an approval process, so it isn't available to just
   * anyone building an activity. The people already on the call are a better
   * list for this purpose anyway: a watch party invites the room it is in.
   *
   * Empty on any failure (a DM context has no guild channel to read), which the
   * caller renders as "nobody to list" and falls back to the dialog.
   */
  listCallMembers: () => Promise<CallMember[]>;
  /**
   * Invite one person straight into this activity instance.
   *
   * The same semantics as the channel invite — they land in this room, in sync
   * — but addressed to a person rather than posted somewhere.
   */
  inviteUser: (userId: string) => Promise<boolean>;
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
/** A person in the activity's voice channel, trimmed to what the picker draws. */
export interface CallMember {
  id: string;
  /** Display name — Discord's global_name when set, else the username. */
  name: string;
  username: string;
}

export type InviteResult =
  /** The dialog opened. Whether they actually invited anyone is Discord's business. */
  | "opened"
  /** No channel, or no permission to create an invite — worth a quiet note. */
  | "unavailable";

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID as string;

export function useDiscord(): DiscordState {
  const [state, setState] = useState<
    Omit<DiscordState, "openInvite" | "listCallMembers" | "inviteUser" | "setPresence" | "canInvite">
      & { canInvite: boolean }
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

  const listCallMembers = useCallback(async (): Promise<CallMember[]> => {
    const sdk = sdkRef.current;
    if (!sdk?.channelId) return [];
    try {
      const channel = await sdk.commands.getChannel({ channel_id: sdk.channelId });
      return (channel?.voice_states ?? [])
        .map((v) => v.user)
        .filter((u) => u && !u.bot)
        .map((u) => ({
          id: u.id,
          name: u.global_name || u.username,
          username: u.username,
        }));
    } catch (err) {
      // A DM context, or a client that won't answer — the caller falls back to
      // Discord's own dialog rather than showing an empty picker.
      logEvent("Discord", "could not read the call roster", {
        reason: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }, []);

  const inviteUser = useCallback(async (userId: string): Promise<boolean> => {
    const sdk = sdkRef.current;
    if (!sdk) return false;
    try {
      await sdk.commands.inviteUserEmbedded({ user_id: userId });
      logEvent("Discord", "invited a user to the activity", { userId });
      return true;
    } catch (err) {
      logEvent("Discord", "user invite failed", {
        userId,
        reason: err instanceof Error ? err.message : String(err),
      });
      return false;
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
          // guildId, not channelId. A (G)DM call *has* a channel id, so that
          // test passed there and offered a button whose every route fails:
          // openInviteDialog throws INVALID_CHANNEL without a guild, and
          // getChannel on a DM needs an approval-gated scope. Hidden is better
          // than present and broken.
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

  return { ...state, openInvite, listCallMembers, inviteUser, setPresence };
}
