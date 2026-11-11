# Dashboard

The Theater dashboard is a web page for the server's owner. It shows what is
playing right now, who is watching, why each stream is sent unchanged or
transcoded, and where the data is coming from. It also keeps a history of
every session, with statistics, users, requests, caches and logs.

It runs on a port of its own, apart from the Activity, and only once you set a
password.

## Turn it on

1. Set `ADMIN_PASSWORD` to a password of 12 characters or more.
2. Publish its port in the compose file:

   ```yaml
   ports:
     - "3000:3000"
     - "3050:3050"
   ```

   Keep this port on your local network: don't forward it on your router or
   route it through your tunnel. To publish it on one address of the server
   only, put that address in front, as in `"<server address>:3050:3050"`.

3. Restart the container. The log says where it listens:

   ```text
   [Admin] dashboard listening url=http://localhost:3050
   ```

4. Open `http://<your server>:3050` and sign in.

| Setting | Default | Description |
|---|---|---|
| `ADMIN_PASSWORD` | None | Turns the dashboard on, and is its password |
| `ADMIN_PORT` | `3050` | Its port inside the container. It can't be the same as `PORT`. |
| `ADMIN_HOST` | `0.0.0.0` | The address it listens on inside the container |

> [!TIP]
> If your password is in a `.env` file and contains a `$` or a `#`, wrap it in
> single quotes: `ADMIN_PASSWORD='pa$$word#1'`. Docker Compose otherwise reads
> `$name` as a variable, and the password the server gets is not the one you
> typed.

`ADMIN_SECRET` is a different setting: the password for one maintenance
command. See [Configuration Reference](Configuration-Reference#access-and-security).

## Keep it private

- The dashboard is plain HTTP. Keep it on your LAN or a VPN. Don't route it
  through the tunnel or reverse proxy that serves the Activity.
- The Activity's port never serves the dashboard, so Discord's proxy can't
  reach it.
- Each address gets 10 sign-in attempts every 15 minutes. A wrong password is
  logged with the address it came from.
- A sign-in lasts 12 hours. Restarting the container signs everyone out.
- Secrets are never shown. A setting whose name ends in `KEY`, `TOKEN`,
  `SECRET`, `PASSWORD` or similar shows only that it is set. Tokens are removed
  from URLs and from log lines.

## Now Playing

Updated every 2 seconds. The browser tab shows how many sessions are active.

**At the top**

| Tile | Shows |
|---|---|
| Active sessions | Rooms with a title playing, and rooms open |
| Viewers | How many are watching, and how many are connected |
| Streams | How many are direct and how many are transcoding |
| Server upload | What your server is sending right now, with its trend, against what the players need |
| Delivery right now | The share served by Discord's cache and by viewers sharing with each other |
| Buffering | Buffering events across active sessions |

**Each session**

- The title's poster, its name, and whether it is playing, paused or
  buffering.
- A progress bar with the position, the running time and the time left.
- The host, how many are watching, the Discord server and channel, and when
  the room opened.
- The bitrate its players need, the data delivered so far, and buffering in
  green, amber or red.
- **Delivery, last 10 minutes.** A live graph of what the players received
  from the server, from Discord's cache and from other viewers, against the
  bitrate they need (the dashed line). Players report every 10 seconds, so
  each point is a 30-second average.
- **Where the data came from.** The session's total, split the same way.

**Each stream** reads at a glance:

- **Direct play**, **Direct stream** or **Transcode**, and its bitrate.
- The video and the audio from source to output. Green means unchanged, amber
  means converted.
- For a transcode, the reason in a sentence.

Select a stream for its details, in four groups: video, audio, delivery and
identifiers.

**Each viewer** shows their role, whether they are watching, buffering, away
or disconnected, which stream they are on, how long they have watched, the
data they received with its split, and their buffering. Select a viewer for
their Discord user ID, quality limit, subtitle track, and what their device
can play.

## History

Every session, newest first, each with its poster: the title, when it started,
the host, the Discord server and channel, who watched, how long it played,
whether its streams were direct or transcoded, the data delivered with its
split, and whether playback was smooth.

Search finds a title, a viewer's name or Discord user ID, or a server or
channel ID. **CSV** and **JSON** export every session the search finds.

Select a session to open it:

| Section | Shows |
|---|---|
| Summary | How it ended, time played, viewers, streams, data delivered and buffering, then where the data came from |
| Viewers | Each person's role, watch time, data received and buffering |
| Streams | Each stream, as on Now Playing |
| Session overview | A chart of the session over time: one row for playback (playing, paused, held), one for each stream and one for each viewer, with marks where something changed. Hover any bar or mark for details. |
| Key moments | The events that explain the session, each with its reason: a stream starting and why, a viewer changing stream, quality or subtitles, long buffering, and errors. This is where to look when a second stream started part way through. |
| All events | Every event in order, with filters for playback, viewers, streams and tracks, and buffering and errors. Select an event for its details. |

## Statistics

Trends over the last 7 days, 30 days, 90 days, a year, or all time. Days are
UTC, and a session counts on the day it started.

- Sessions, watch time, users, data delivered, the share of streams
  transcoded, and buffering.
- Per day: sessions, watch time, data by source, streams direct or
  transcoded, buffering, launches and requests.
- Transcode reasons, the most common first.
- Sessions by hour of the day and by weekday.
- The most watched titles, the most active users, and the most active Discord
  servers.

**Show table** switches any chart to a table of its numbers.

## Users

Everyone who has used the Activity, most recently active first: their Discord
user ID, sessions, sessions hosted, launches, watch time, data received,
buffering, requests, and the last title they watched. Select a user for the
servers and channels they used, every session they were in, and every title
they requested.

## Discord Servers

Each Discord server the Activity was used in, and each of its channels:
launches, joins, users, sessions and time played. Below, every launch and join,
newest first.

Discord shares server and channel IDs with an Activity, not their names. To
match an ID, turn on Developer Mode in Discord, then right-click the server or
channel and choose **Copy ID**.

## Requests

Every title requested through Seerr from the Activity: who asked, the title,
the seasons, and the result. **Status now** asks Seerr for the request's
current state, so a request that was approved, declined or filled since it was
made shows as such.

## Caches

- **Discord cache efficiency.** How much of the video players downloaded was
  served by Discord's cache instead of your server, over the last day, the
  last week and all time, and for each title.
- **Each cache the server keeps**, with its size against its limit, where it
  is, how long things are kept, and what it holds: video being played, artwork,
  title details, subtitles, seek-bar previews and subtitle fonts.

## Logs

The server's log files, newest first. Filter by level, tag or text, and show
the last 200 to 5000 lines. **Follow** refreshes every 5 seconds. Lines
reported by a viewer's player are labelled with that player. Times are UTC.

## System

- **Status.** Version, uptime, memory and platform.
- **History database.** Where `admin.sqlite` is, its size, what it holds and
  the period it covers. **Download database** saves a copy. **Delete old
  history** keeps the most recent days you choose: **Preview deletion** shows
  what would go, and nothing is deleted until you confirm. Sessions in
  progress are never deleted.
- **Configuration.** Every environment setting the server reads, grouped by
  area. They are shown for reference. To change one, edit your compose file
  or `.env` and restart the container.

## What is recorded

While the dashboard is on, the server records into `admin.sqlite`, in the data
folder:

- **Each session:** a title played in a room, from start to end, with where in
  Discord it was, who hosted it, and how it ended.
- **Each viewer of a session:** how long they watched, the data their player
  received and where from, their buffering, and their player's errors.
- **Each stream:** direct or transcoded and why, its tracks, quality and
  bitrate, who it was made for, and when it started and ended.
- **Each event:** plays, pauses and seeks with who did them, people joining
  and leaving, track and quality changes, buffering and errors.
- **Usage:** each launch of the Activity and each person joining a room.
- **Requests:** each title requested through Seerr.

Nothing is deleted unless you delete it on the System page. Without
`ADMIN_PASSWORD`, nothing is recorded. Back up `admin.sqlite` with the rest of
the data folder. See [Updating and Backups](Updating-and-Backups).

## Exports and API

A signed-in browser can read everything as files or JSON.

| Path | Returns |
|---|---|
| `/api/overview` | Every room right now |
| `/api/history` | Sessions, newest first. `?q=` searches. `?before=<id>` is the next page. |
| `/api/history/<id>` | One session: its viewers, streams and events |
| `/api/people`, `/api/people/<id>` | Users, and one user |
| `/api/places` | Each Discord server and its channels |
| `/api/usage` | Launches and joins, newest first |
| `/api/requests` | Title requests, with Seerr's current status |
| `/api/caches` | Each cache and what it holds |
| `/api/graphs` | Statistics by UTC day. `?days=` is the period: 30 unless given, 0 for all time. |
| `/api/export/<list>.csv`, `.json` | `history`, `people`, `usage` or `requests`, as a file. `?q=` is the list's search. At most 200,000 rows. |
| `/api/export/admin.sqlite` | A copy of the whole history database |

CSV files are UTF-8 and open in a spreadsheet. Text that a spreadsheet would
run as a formula is written with a `'` in front.

## Next

→ [Configuration Reference](Configuration-Reference)
