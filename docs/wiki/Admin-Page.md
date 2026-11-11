# Admin Page

A page for the server's owner that shows what the bot is doing right now:
every room, who is in it, each stream and why it is copied or re-encoded, the
server's logs and its settings. It also keeps a history of every play, of
everybody who used the bot and where, of title requests, and shows what each
cache holds. It runs on a port of its own, apart from the Activity, and only
once a password is set.

## Turning it on

1. Set `ADMIN_PASSWORD`, 12 characters or more.
2. Publish its port, 3050, in the compose file. Publish it on your LAN
   address only:

   ```yaml
   ports:
     - "3000:3000"
     - "192.168.1.10:3050:3050"
   ```

3. Restart the container. The log says where it listens:

   ```text
   [Admin] admin page listening url=http://localhost:3050
   ```

4. Open `http://<server>:3050` and sign in with the password.

| Setting | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | None | Turns the page on, and is its password |
| `ADMIN_PORT` | `3050` | Its port. It can't be `PORT`. |
| `ADMIN_HOST` | `0.0.0.0` | The address it listens on inside the container |

`ADMIN_SECRET` is something else: the password for one maintenance command.
See [Configuration Reference](Configuration-Reference#access-and-security).

## Keeping it private

- The page is plain HTTP. Keep it on your LAN or a VPN. Don't route it
  through the tunnel or reverse proxy that serves the Activity. If you put it
  behind HTTPS of your own, its cookie is marked Secure.
- The Activity's port never serves the page or its API, so Discord's proxy
  can't reach it.
- Each address gets 10 sign-in attempts every 15 minutes. A wrong password is
  logged with the address it came from.
- A sign-in lasts 12 hours. Restarting the container signs everyone out.
- Secrets are never shown. A setting whose name ends in `KEY`, `TOKEN`,
  `SECRET`, `PASSWORD` or similar shows only that it is set and its length.
  Credentials and tokens are removed from URLs, and from log lines.

## What it shows

### Now playing

Updated every 2 seconds.

- **Totals:** rooms, people connected and watching, streams copied and
  re-encoded, and the upload: one feed per stream somebody watches, before
  Discord's cache and peer sharing take their share.
- **Each room:**
  - its title, whether it plays, is paused or waits for somebody, and where
    it is;
  - the Discord server, channel and host, by ID, and when it started;
  - when somebody last played, paused or sought;
  - when the host was last heard from;
  - the queue.
- **Each stream:** one line saying whether it is a direct copy or re-encoded,
  and why, in the words the player's Stats for nerds uses. Also the engine,
  bitrate, quality and who watches it. Select it for the details:
  - its HLS session and tracks;
  - who drives it;
  - its Plex transcode key;
  - the player Plex's Now Playing lists it under;
  - everything its playlist told the players about it.
- **People:**
  - name and Discord ID;
  - role;
  - whether they are watching, buffering, away from Discord or disconnected;
  - which stream they are on, their subtitle and quality;
  - what their player can decode;
  - when they joined;
  - how long they have watched, the data their player has had (from the bot,
    Discord's cache and other viewers), and their buffering, so far in this
    play.

A room on two streams, such as a viewer whose player can't decode the host's
10-bit HEVC and is given an 8-bit stream of their own, shows both streams.

### History

Every play, newest first: the title, the Discord server and channel, the host,
who watched, how long it played, its streams, the data sent and how many
times a picture stopped. Search finds a title, a person's name or Discord ID,
or a server or channel ID.

Opening a play shows:

- **Its viewers:** each person's role, how long they watched, the data their
  player got (from the bot, from Discord's cache, from other viewers) and
  their buffering.
- **Its streams:** each one copied or re-encoded, and why. Opening one shows
  its tracks, who it was made for, where in the title it starts, and what its
  playlist told the players.
- **What happened:** every line in order, with the time (UTC) and where in
  the title it was. Buttons above the list show or hide playback, people,
  streams and tracks, and buffering and errors. Opening a line shows its
  details.

### People

Everybody the bot has seen, the latest first: their Discord ID, plays, plays
hosted, launches of the Activity, time watched, data, buffering, requests,
and the last thing they watched. Opening a person shows where they used the
bot, every play they were in (as host, co-host or viewer, with their own
data), and every title they asked for.

### Servers

Each Discord server the Activity was used in, and each of its channels: how
many times it was launched there, who joined, and the plays and time played.
Below, every launch and join, newest first.

Discord tells the bot a server's and a channel's ID, not their names. To match
one in Discord, turn on Developer Mode, then right-click the server or channel
and choose Copy ID.

### Requests

Every title asked for through Seerr, newest first: who asked, the title, film
or series, the seasons, its TMDB ID, and what came of it. A request made shows
Seerr's status for the title (pending, processing, available...); one already
asked for, or failed, shows what Seerr answered. Search finds a title, a
person's name or Discord ID, or a TMDB ID.

### Caches

What the bot keeps, each with its size against its limit, where it is, how
long things are kept, and a list of what it holds, with the title of each where
it can be told:

- films being copied for a room, and FFmpeg's streams (with the segments kept
  in memory);
- artwork, title details, and subtitles read out of files;
- picture subtitles, seek-bar previews and subtitle fonts.

At the top, **Discord's cache:** of what players fetched over the last day,
the last week and all the history, how much Discord's cache answered and how
much the bot sent; and the same for each title. It comes from what players
report, so it needs the history.

### Logs

The server's log files from `LOG_DIR`, newest first. You can filter by level,
tag or text, and show the last 200 to 5000 lines. **Follow** refreshes every
5 seconds. Lines sent by a viewer's player are labelled with that player.
Times are UTC.

### Settings

The version, Node.js, uptime and memory. Then every setting the server reads,
with its value, or "Not set" for one left at its default.

## What is recorded

While the page is on, the bot records into `admin.sqlite`, in the data
folder:

- **Each play:** a title played in a room, from start to end. Where in Discord
  it was, who hosted it, how long it played, and the most people watching at
  once. How it ended: stopped, and by whom; another title; the room closing;
  or the server stopping.
- **Each viewer of a play:**
  - how long they watched while it played;
  - the data their player got, and where from: the bot, Discord's cache, or
    other viewers;
  - how many times their picture stopped for want of data, and for how long;
  - their player's errors.
- **Each stream a play made:** copied or re-encoded and why, its tracks,
  quality and bitrate, who it was made for, and when it started and ended. A
  stream started again, after a seek or under a new session, is a restart.
- **What happened during the play, in order:**
  - plays, pauses, and seeks from where to where, each with who did it;
  - people joining, leaving, and going away from Discord;
  - a viewer changing stream, subtitles or quality;
  - the room waiting for its slowest viewer;
  - buffering, loading after a seek, and player errors.
- **Usage:** each launch of the Activity and each person joining a room, with
  the Discord server and channel.
- **Requests:** each title asked for through Seerr, by whom, and whether it
  was requested, already requested, or failed.

Players say what they have downloaded every 10 seconds. "From the bot" is
what came over HTTP, less what Discord's cache answered.

A request from somebody not yet seen in a room is named once they are.

A signed-in browser can also read all of it as JSON:

| Path | What |
|---|---|
| `/api/history` | Plays, newest first. `?q=` finds a title, a person's name or ID, or a server or channel ID. `?before=<id>` is the next page. |
| `/api/history/<id>` | One play: its viewers, streams and everything that happened |
| `/api/people` | Everybody seen, the latest first. `?q=` finds a name or ID; `?offset=` is the next page. |
| `/api/people/<id>` | One person: their plays, requests, and where they used the bot |
| `/api/places` | Each Discord server and its channels |
| `/api/usage` | Launches and joins, newest first. `?before=<id>` is the next page. |
| `/api/requests` | Title requests, newest first. `?q=` finds a title, a name or ID, or a TMDB ID. |
| `/api/caches` | Each cache and what it holds, and Discord's cache (this one works without the history) |

Nothing is removed from `admin.sqlite` yet. To start over, stop the bot and
delete the file. If the server is stopped without warning, its plays still
open end where they were last seen when the bot starts again. Without
`ADMIN_PASSWORD`, nothing is recorded.

## Next

→ [Local Development](Local-Development)
