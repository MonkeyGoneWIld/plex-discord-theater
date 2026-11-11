# FAQ

Answers to common questions. For something that isn't working, see
[Troubleshooting](Troubleshooting).

## Watching

### Do viewers need a Plex account?

No. Everyone watches through the server owner's Plex server. A viewer needs a
Plex account only to have their own watch history and Watchlist kept in Plex;
see [Personal Plex Sync](Personal-Plex-Sync).

### Where can the Activity be started?

In any voice or text channel of a Discord server where it is available, and in
DMs and group DMs. Nobody has to join a voice call. Everyone who opens it in
the same channel joins the same room, and different channels have separate
rooms.

When `ALLOWED_GUILD_IDS` is set, the Activity works only in the servers it
lists, and not in DMs.

### Do viewers need to be in my Discord server?

They need to be in the server or DM where the Activity is running. While your
application is unverified, they also need to be
[app testers](Discord-Application-Setup#6-add-your-viewers-as-app-testers).

### Does it work on phones?

Yes, in the Discord mobile app, upright or sideways. See
[Phone gestures](Using-the-Activity#phone-gestures).

### Can each viewer choose their own audio and subtitles?

Yes. Audio, subtitles, subtitle timing and look, quality and volume are each
viewer's own, so two people can watch the same film in different languages, in
sync. When the host changes tracks, viewers who are on the host's tracks move
with them; anyone who chose their own keeps them. See
[Audio and subtitles](Using-the-Activity#audio-and-subtitles).

### Does one viewer with a slow connection lower everyone's picture?

No. A viewer gets a stream of their own, without changing anyone else's, when
they choose a lower quality, when their player can't decode the room's video
(such as HEVC in Discord in Firefox), or when their device keeps dropping
frames. This applies to the host too.

### Does one slow viewer hold everyone up?

No. The room waits only for the host's picture: when a title starts, after the
host seeks, and when the host's own picture stops. A viewer whose picture stops
buffers on their own screen while everyone else keeps watching, then rejoins
the room's position. A viewer who is still loading when the room starts joins
in where the room has reached.

### What happens when the host leaves?

Someone else becomes host straight away and playback continues. The room
chooses, in order: someone on the host's stream, a co-host, someone watching,
then whoever joined earliest. A host who comes back within 15 seconds gets the
role back. See [Roles and Permissions](Roles-and-Permissions#who-is-host).

### What if the host walks away?

Anyone can select **Request host** at the foot of the people list. The host
gets five minutes to answer, or one minute if the Activity sees they are away.
If they don't answer, the role passes to whoever asked. See
[Someone asks for it](Roles-and-Permissions#someone-asks-for-it).

### Can someone in the room take control?

Only with a role the host gives them. The server checks every control against
the sender's role, so a modified client can't control the room. Co-hosts can
pause, seek and change episode, but can't start a different title or change
roles.

### Does popping the Activity out interrupt the room?

No. Discord reloads the Activity when it is popped out or back in, and the
player returns to the room's position, usually within a second or two. Nobody
else waits. See [Pop-out windows](Using-the-Activity#pop-out-windows).

### What does Session expired mean?

Your sign-in is older than 24 hours. Close the Activity and open it again.

### Can we watch something that isn't in the library?

Not directly. When Seerr is connected, you can
[request it](Requesting-Titles) from the Activity and watch it once it arrives
in Plex.

## Setting up

### Does it need Plex Pass?

No. Without Plex Pass:

- **Plex transcodes on the CPU, in H.264 only.** Hardware transcoding and HEVC
  encoding are Plex Pass features, and a 1080p transcode on the CPU can take
  several cores.
- **The [FFmpeg engine](FFmpeg-Engine) doesn't need it.** It transcodes on the
  container's own GPU, with Intel Quick Sync, VAAPI or NVIDIA NVENC.
- **Direct play needs neither.** When a file's video can be
  [sent unchanged](Streaming-and-Quality#when-video-is-sent-unchanged), nothing is transcoded.
- **Skip Intro and Skip Credits** need Plex's intro and credits markers, which
  Plex creates only with Plex Pass.

### How many people can watch at once?

There is no fixed limit: your upload speed decides. At the default settings a
stream needs 20 to 25 Mbps. Viewers on the same stream share it: Discord's
proxy caches the video, and viewers pass pieces to each other, so the second
and later viewers get most of theirs without it coming from your server. Each
viewer on a stream of their own needs that stream's bitrate as well. See
[Upload speed](Requirements#upload-speed).

### Why is it limited to servers with fewer than 25 members?

That is Discord's rule for unverified applications. It limits the size of the
Discord server, not the number of viewers. Verifying the application removes
it; see
[Verifying the application](Discord-Application-Setup#verifying-the-application).

### Do I need a domain?

You need a public HTTPS address. A Cloudflare quick tunnel gives you one
without a domain, but its address changes every time it starts, so it suits
testing only. For regular use, a named tunnel or a reverse proxy needs a
domain. See [HTTPS and Reverse Proxy](HTTPS-and-Reverse-Proxy).

### Should I use the FFmpeg engine?

It is optional. It suits you if you want transcodes on a GPU without Plex
Pass, HDR kept in transcodes, or picture subtitles without a transcode. It
needs read access to the library's files, and a GPU for transcodes. See
[Plex engine or FFmpeg engine?](FFmpeg-Engine#plex-engine-or-ffmpeg-engine).

### Can I run it without Docker?

Yes, with Node.js 24 or later: `npm install`, `npm run build` and `npm start`.
Docker is recommended, because the image includes the FFmpeg engine's ffmpeg,
GPU drivers and subtitle fonts. From source, the engine uses the `ffmpeg` on
your `PATH`, or
[`FFMPEG_PATH`](FFmpeg-Engine#settings).

### Can I use the published image with my own Discord application?

Yes. The server adds your Discord application ID to the page when it serves it,
so the same image works for everyone. See
[Installation](Installation#install-the-published-image).

### Can I limit which Discord servers can use it?

Yes, with `ALLOWED_GUILD_IDS`. The server checks each person's membership with
Discord, and refuses DMs while the setting is in use. See
[Access and security](Configuration-Reference#access-and-security).

### How do I see what is playing and why?

Turn on the [Dashboard](Dashboard). It shows every room live, each stream and
why it is direct or transcoded, where the data is coming from, and a history
of every session.

### Does it work with Jellyfin or Emby?

No. It is built around Plex's library, metadata, streams and watch history.

## Streaming

### Why does it convert files instead of playing them directly?

Browsers can't play most library files as they are, often because of the file
format rather than the video. Everything is sent to the player as HLS
segments. When the device can play the video, it is put into those segments
unchanged, 4K included, and only the audio is converted when it has to be. The
video is transcoded only when it can't be sent unchanged, for example a file
above your bitrate limit or a codec the device can't play. See
[The three ways a title plays](Streaming-and-Quality#the-three-ways-a-title-plays).

### Why is my stream transcoded when it could be sent unchanged?

Open **Stats for nerds** (press `I`): its **Playback** row says why. The most
common reasons are:

- **A picture subtitle has to be burned in.** With the Plex engine, PGS,
  VobSub and DVB always are. The FFmpeg engine has each player draw PGS, and
  VobSub or DVB inside the film, instead. A VobSub beside the film (`.idx` and
  `.sub`) is still burned in.
- **The file is above your bitrate limit** (`DIRECT_STREAM_MAX_KBPS`, 25 Mbps
  by default), or above the quality the viewer chose.
- **The file is 10-bit H.264**, which Discord's player doesn't play.
- **The file is above 1080p and this player can't decode it smoothly.** That
  player gets a 1080p transcode of its own; everyone else gets the file as it is.
- **The player can't decode the codec**, such as HEVC in Discord in Firefox.
- **Plex treats the server as remote.** See
  [LAN Networks](Plex-Setup#lan-networks).

### Why did someone buffer when the host changed?

A change of host doesn't restart anybody's stream, but a player with little
buffered may pause briefly. See
[Buffering when the host changes](Troubleshooting#buffering-when-the-host-changes).

### Can viewers see my Plex token?

No. The server makes every request to Plex itself and serves every segment, so
your tokens never reach a viewer's browser. Linked viewers' tokens are stored
encrypted, and the logs remove tokens.

## About the project

### Is it affiliated with Plex or Discord?

No. It is an independent, self-hosted project that uses their public APIs.

### Where do I report a problem?

On [GitHub](https://github.com/MonkeyGoneWIld/plex-discord-theater/issues).
[Report a problem](Troubleshooting#report-a-problem) lists what to include.
