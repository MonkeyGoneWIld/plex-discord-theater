# Dashboard

The Theater dashboard is a page for the server's owner. It shows what is
playing right now in every room: who is watching, each stream and why it is
sent unchanged or transcoded, and where the data is coming from. It also
keeps a history of every session, every user, the Discord servers the
Activity is used in, title requests, statistics, the caches, the server's
logs and its settings. It runs on a port of its own, apart from the Activity,
and only once a password is set.

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
   [Admin] dashboard listening url=http://localhost:3050
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

- The dashboard is plain HTTP. Keep it on your LAN or a VPN. Don't route it
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

### Now Playing

Updated every 2 seconds. The browser tab shows how many sessions are active.

- **At the top:** active sessions, viewers, streams (direct and
  transcoding), the server's upload right now with its trend, the share of
  delivery taken off the server by Discord's cache and by viewers sharing
  with each other, and buffering across active sessions.
- **Each session:**
  - the title's poster, its name, and whether it is playing, paused or
    buffering;
  - a progress bar with the position, the running time and the time left;
  - the host, how many are watching, the Discord server and channel by ID,
    and when the room opened;
  - the bitrate its players need, the data delivered so far, and buffering,
    in green, amber or red;
  - **Delivery, last 10 minutes:** a live graph of what the players
    received each moment from the server, from Discord's cache and from
    other viewers, against the bitrate they need (the dashed line). Players
    report every 10 seconds, so each point is a 30-second average;
  - **Where the data came from:** the session's total, split the same way.
- **Each stream:** Direct play (nothing converted), Direct stream (audio
  converted) or Transcode, with the reason in a sentence, as the player's
  Stats for nerds says it. Also its video and audio from source to output,
  the engine, bitrate, quality and who is watching it. Select it for the
  technical details: its HLS session and tracks, who requested it, its Plex
  transcode key, the player Plex's Now Playing lists it under, and every
  property its playlist carries.
- **Viewers:** name and role, whether they are watching, buffering, away or
  disconnected, which stream they are on, how long they have watched, the
  data they received with its split, and their buffering. Select a viewer
  for their Discord user ID, quality limit, subtitle track, what their
  player can decode, and when they joined.

A room on two streams, such as a viewer whose player can't decode the host's
10-bit HEVC and is given an 8-bit stream of their own, shows both streams.

### History

Every session, newest first, each with its poster: the title, when it
started, the host, the Discord server and channel, who watched, how long it
played, whether its streams were direct or transcoded, the data delivered
with its split by source, and whether playback was smooth. Search finds a
title, a viewer's name or Discord user ID, or a server or channel ID. Above
the list, sessions per day over the last 30 days. **CSV** and **JSON**
export every session the search finds; the JSON has each session whole, with
its viewers, streams and timeline.

Opening a session shows:

- **At the top:** its poster, how it ended, time played, viewers, streams,
  data delivered and buffering, then where the data came from.
- **Viewers:** each person's role, how long they watched, the data they
  received with its split, and their buffering.
- **Streams:** each one Direct play, Direct stream or Transcode, and why.
  Opening one shows its tracks, who requested it, where in the title it
  starts, and the properties its playlist carried.
- **Timeline:** every event in order, with the time (UTC) and the playback
  position, marked by kind. Buttons above the list show or hide playback,
  viewers, streams and tracks, and buffering and errors. Opening an event
  shows its details.

### Statistics

The history over the last 7 days, 30 days, 90 days, a year, or all of it.
Days are UTC, and a play counts on the day it started. Over 120 days the
charts go by week, and over two years by month.

- At the top: plays and time played, time watched by everybody, people,
  launches and requests, the data players got and how much of it came from
  Discord's cache, the share of streams re-encoded, and buffering.
- Per day: plays; time watched; data, split into what came from the bot,
  from Discord's cache and from other viewers; streams copied or re-encoded;
  buffering; launches and requests.
- Why streams were re-encoded, the most common reason first.
- Plays by hour of the day and by weekday, UTC.
- The most watched titles, who watched most, and the Discord servers it was
  watched in. Picking a person opens them.

Pointing at a column shows its numbers. **Show table** shows a chart's
numbers as a table instead.

### Users

Everybody the bot has seen, the latest first: their Discord ID, plays, plays
hosted, launches of the Activity, time watched, data, buffering, requests,
and the last thing they watched. Opening a person shows where they used the
bot, every play they were in (as host, co-host or viewer, with their own
data), and every title they asked for. Above the list, who watched most over
the last 30 days; **CSV** and **JSON** download everybody the search finds.

### Discord Servers

Each Discord server the Activity was used in, and each of its channels: how
many times it was launched there, who joined, and the plays and time played.
Below, every launch and join, newest first, which **CSV** and **JSON**
download.

Discord tells the bot a server's and a channel's ID, not their names. To match
one in Discord, turn on Developer Mode, then right-click the server or channel
and choose Copy ID.

### Requests

Every title asked for through Seerr, newest first: who asked, the title, film
or series, the seasons, its TMDB ID, and what came of it. A request made shows
Seerr's status for the title (pending, processing, available...); one already
asked for, or failed, shows what Seerr answered. Search finds a title, a
person's name or Discord ID, or a TMDB ID. **CSV** and **JSON** download
every request the search finds.

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
much the bot sent; and the same for each title. Below it, the data players
got per day over the last 30 days, and where it came from. It comes from what
players report, so it needs the history.

### Logs

The server's log files from `LOG_DIR`, newest first. You can filter by level,
tag or text, and show the last 200 to 5000 lines. **Follow** refreshes every
5 seconds. Lines sent by a viewer's player are labelled with that player.
Times are UTC.

### Settings

The version, Node.js, uptime and memory. Then the history: where
`admin.sqlite` is, its size, what it holds, and from when.

- **Download database (admin.sqlite)** downloads the whole file as it is,
  for a backup or your own queries.
- **Delete old history** keeps the most recent days you choose (1 to 3650).
  **Preview deletion** shows what would be removed: the plays that ended before then,
  with their viewers, streams and lines, the launches, joins and requests
  from before then, and people seen only before then. A play still going is
  never removed. **Delete permanently** removes them, which can't be undone, then
  shrinks the file and says how big it was and is. The server's log says
  what was removed.

Nothing is removed unless you do it here.

Then every setting the server reads, with its value, or "Not set" for one
left at its default.

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
| `/api/titles` | A title's poster and running time, by Plex item: `?keys=1,2,3` |
| `/api/poster/<item>` | A title's poster, as Plex has it |
| `/api/graphs` | The history by UTC day, with totals, hours, weekdays and top tens. `?days=` is the period: 30 unless given, 0 for all of it. |
| `/api/history-file` | Where `admin.sqlite` is, its size and what it holds. With `?days=`, what removing what is older would remove. |
| `/api/export/<list>.csv`, `.json` | `history`, `people`, `usage` or `requests`, all of it, as a file. `?q=` is the list's search. At most 200,000 rows. |
| `/api/export/admin.sqlite` | A copy of the whole history file |

`POST /api/history-file/trim` with `{"days": N}` removes what is older than N
days, as **Delete permanently** does.

CSV files are UTF-8 and open in a spreadsheet. Text that a spreadsheet would
run as a formula (starting with `=`, `+`, `-` or `@`) is written with a `'`
in front, since names and titles come from anybody.

Old history is removed only from the Settings page. To start over, stop the
bot and delete the file. If the server is stopped without warning, its plays
still open end where they were last seen when the bot starts again. Without
`ADMIN_PASSWORD`, nothing is recorded.

## Next

→ [Local Development](Local-Development)
