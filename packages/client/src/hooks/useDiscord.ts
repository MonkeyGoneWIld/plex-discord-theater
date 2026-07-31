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
  /** Whether this launch context can invite anyone — false in a DM call, where
   *  Discord has no invite to offer. */
  canInvite: boolean;
  /**
   * Open Discord's own "invite to activity" dialog. Resolves false when the
   * dialog couldn't be opened — no channel, missing permission, or the user
   * dismissing it — so the caller can say so rather than appear to do nothing.
   */
  openInvite: () => Promise<boolean>;
}

const CLIENT_ID = import.meta.env.VITE_DISCORD_CLIENT_ID as string;

export function useDiscord(): DiscordState {
  const [state, setState] = useState<
    Omit<DiscordState, "openInvite" | "canInvite"> & { canInvite: boolean }
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

  const openInvite = useCallback(async (): Promise<boolean> => {
    const sdk = sdkRef.current;
    if (!sdk) return false;
    try {
      await sdk.commands.openInviteDialog();
      logEvent("Discord", "invite dialog opened", {});
      return true;
    } catch (err) {
      // Thrown for a context with nothing to invite to (a DM call) and when the
      // user lacks Create Invite in the channel. Neither is our failure, and
      // neither is worth an error banner — the caller shows a quiet note.
      logEvent("Discord", "invite dialog unavailable", {
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
          scope: ["identify", "guilds", "rpc.voice.read"],
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
        try {
          await sdk.commands.setActivity({
            activity: {
              type: 3,
              details: "Watch Together",
              state: "Browsing the library",
            },
          });
        } catch (activityErr) {
          // Non-fatal — app still works if Rich Presence can't be set
          console.warn("setActivity failed:", activityErr);
        }

        setState({
          isReady: true,
          isHost,
          userId: user.id,
          username: user.username,
          instanceId: sdk.instanceId,
          error: null,
          // A DM or group-DM call has no channel to invite into, so the button
          // is hidden rather than offered and then failing.
          canInvite: sdk.channelId != null,
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

  return { ...state, openInvite };
}
