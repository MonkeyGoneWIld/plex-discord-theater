# Dashboard

The Theater Dashboard is a web page for the server's owner. It shows the
sessions in progress, who is watching, why each stream is sent as direct play,
direct stream or transcode, and where each player's data comes from. It keeps
a history of every session, with statistics, users, requests, caches, logs and
the server's load.

It runs on a port of its own, apart from the Activity, and only once you set a
password. Times are shown in your browser's time zone, on a 12-hour clock.

![The Activity page: a session in progress with its figures, streams and viewers](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/dashboard-now-playing.png)

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

4. Open `http://<your server>:3050` and sign in. It opens on Activity.

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
- A sign-in lasts until you sign out, through restarts of the container.
  Changing `ADMIN_PASSWORD` signs everyone out. Each port has its own
  sign-in, so two servers' dashboards on one machine don't sign each other
  out.
- Secrets are never shown. A setting whose name ends in `KEY`, `TOKEN`,
  `SECRET`, `PASSWORD` or similar shows only that it is set. Tokens are removed
  from URLs and from log lines.

## Activity

Sessions in progress, updated every 2 seconds. The browser tab shows how many
are active.

**At the top**

| Figure | Shows |
|---|---|
| Active sessions | Rooms with a title playing, and rooms open |
| Viewers | Viewers watching now, and viewers connected |
| Streams | Streams in progress by delivery method: direct play, direct stream and transcode |
| Server upload | What the server is sending now, with its trend, against the bitrate the players require |
| Current offload | The share of data served by Discord's cache and by peers |
| Buffering | Buffering events across active sessions |

**Each session**, in this order:

1. **Title.** The poster, the name, and the playback state: playing, paused,
   or waiting for the host's player, with the reason (starting, after a
   seek, or an audio track change). Viewers who are not ready yet catch up
   while it plays. Below it, a progress bar with the position, the running
   time and the time remaining; the host, how many are watching, the Discord
   server and channel by name, and when the room opened.
2. **Figures.** Streams by delivery method, the bitrate the players require,
   the data delivered with its split by source (server, Discord cache,
   peers), and buffering in green, amber or red.
3. **Viewers.** Each viewer's role and client (the Discord desktop app, the
   Discord app on a phone, Vesktop, or a browser, with the operating system),
   status, stream, sync offset from the session position to a hundredth of a
   second (as the player's Stats show it), buffer in seconds
   with its trend over the last 10 minutes on the timeline's 0 to 150 second
   scale (amber under 10 seconds), watch time, data received with
   its split, data sent to peers, and buffering. Status is the player's last
   report: watching, loading (at the start or after a seek), buffering and
   for how long, out of sync (more than 2 seconds from the session
   position), away from Discord, or disconnected. Loading is not counted as
   buffering. Select a viewer for their details in three groups: **User and
   client** (Discord user ID, when they joined, client, the formats the
   client can play, and its user agent), **Playback** (stream, quality limit,
   subtitle track by name, buffering and player errors) and **Data** (received
   from the server, Discord's cache and other viewers, and sent to other
   viewers).
4. **Streams.** Each stream, described below.
5. **Session timeline.** The session's timeline as History draws it,
   refreshed every 10 seconds, with a link to the session in History. See
   [Session timeline](#session-timeline).
6. **Peer-to-peer sharing.** Video data relayed from one viewer's player to
   another, by sender and receiver, largest first.

**Each stream** reads at a glance:

- **Direct play**, **Direct stream** or **Transcode**, and its bitrate.
- The video and the audio from source to output. Green means unchanged, amber
  means converted.
- For a transcode, the reason in a sentence.
- For a stream the server makes itself, its encoding speed against real time,
  how far ahead of the viewer it is, and what it is using: the share of the
  GPU's video engine and how many CPU cores (on Linux with a GPU passed
  through). A stream that is far enough ahead pauses until the viewer needs
  more, and says so. Plex doesn't report this for its own transcodes.

Select a stream for its details, in four groups: video, audio, delivery and
identifiers. Audio and subtitle tracks show by name, with Plex's number beside.

When every viewer leaves a room, its session is retained briefly so that the
host can resume from the same position. When a viewer on a stream of their own
disconnects, that stream is retained briefly in case they reconnect. The
session says so, by name, while either is the case.

## History

At the top, sessions per day over the last 30 days, with a link to
Statistics. Below it, every session, newest first, each with its poster: the
title, when it started, the host, the Discord server and channel, who watched,
how long it played, the delivery method of its streams, the data delivered
with its split, and its buffering events.

Search finds a title, a viewer's name or Discord user ID, or a server or
channel ID. **CSV** and **JSON** export every session the search finds.

Select a session to open it. Its header shows how it ended, the title, when it
started, the host, the server and channel, and **Logs for this session**,
which opens the server log of that day filtered to the session's time (a
session over midnight UTC has a link for each day's file). Below the header,
the session's figures: time played (with the start and end position), viewers
(with the most at once), streams, data delivered with its split by source,
buffering, and pauses.

![A session in the history: its figures, timeline and viewers](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/dashboard-session.png)

The sections follow in this order, each linked from the bar under the
figures:

| Section | Shows |
|---|---|
| Session timeline | See [Session timeline](#session-timeline) below. |
| Viewers | Each viewer's role and client, the streams they were on, watch time, data received, data sent to peers, buffering, pauses, loading times and time away from Discord. Select a viewer for their details in four groups. **User and client:** Discord user ID, when they were first and last seen, their roles over the session and when each began, and each client they watched on with the formats it can play (a viewer who moved from their computer to their phone shows both). **Playback:** loading at the start and after seeks, time away from Discord, and each pause. **Player health:** from the player's reports every 10 seconds, the sync offset (average and largest; none for the host, whom the session follows), the buffer and the media element buffer in seconds (average and lowest), frames dropped out of frames rendered, the playback rate range while correcting sync, the most peers at once, and the player's peak memory. **Data:** received from the server, Discord's cache and other viewers, and sent to other viewers. A host is in the room before they choose a title, so what they joined on and as is taken from just before the session. |
| Key moments | The significant events and their causes, newest first: a stream starting and why, the host changing a track and who followed, a viewer changing stream, quality or subtitles, a change of host or co-host and how it happened, Skip Intro and Skip Credits, a stream ending early, long buffering, and errors. This is where to look when a second stream started part way through. |
| Viewing coverage | One bar per viewer across the title's runtime, and one for all viewers: the portions they watched, with buffering (a red bar) and player errors (a red diamond) where they happened in the title. For sessions recorded from this version on, each viewer's portions are coloured by how the video reached them: green for direct play or direct stream, amber for transcode. A viewer who joined onto the host's stream is shown on the stream the host was on; striped grey marks a portion whose delivery method was not recorded. The all-viewers bar is grey. Above them, a Seeks row draws each seek as an arc from where it left to where it landed, labelled as on the position line, and a tick where the title finished. |
| Streams | Each stream, as on Activity |
| Media processing | How long the server took to prepare the title and its streams. **Startup** totals file analysis, stream setup and the first segment; each of those has its own figure. Below, every step with its time, the stream it applies to, its duration, its result and its details: file analysis (reading the file's video, audio and subtitle tracks), stream setup (from the stream request to FFmpeg running), first segment (from FFmpeg start to the first playable segment, as a remux or a transcode), full-file remux or transcode (through to the end of the file), subtitle extraction (a whole track, or the lines around the current position), image subtitle conversion (PGS), external subtitle loading, seek preview generation, and a stream that stopped with an error. |
| Peer-to-peer sharing | Video data relayed from one viewer's player to another, by sender and receiver, largest first |
| Event log | Every event, newest first. Select one or more types (playback; viewers; streams and tracks; loading, buffering and errors) to show only those; with none selected, every event is shown. Each event names who did it and how: a seek says whether it came from Skip Intro, Skip Credits, the jump controls or the seek bar; a viewer moving to another client says from which to which; a change of host says how it happened (handed over; requested and accepted; requested with no answer in time, and whether the host was away from Discord; taken back by the host it was passed from; the host leaving, or not reconnecting in time; the host reconnecting in time); a co-host says who granted or removed it; a request for host that was not granted says why (declined by the host, or ended because the requester left or the role changed first, with whether the host was away from Discord and how long they had to respond); a title whose audio ends before its video says where each ends (the audio is padded with silence to the end); and a session's end says whether the title finished, the host closed the player, started the next episode or started a different title. Select an event for its details. |

Loading at the start of a stream, or after a seek, is shown as loading, not
buffering. History recorded by earlier versions is corrected the first time
the server starts on it.

### Session timeline

The session on one time axis, so that a change in one row lines up with its
cause in another. For a long session, **Whole session**, **Last 30 min** and
**Last 10 min** choose the period shown.

- **Playback:** playing, paused, or waiting for the host.
- **Position:** where in the title the session was, from the start of the
  title at the bottom to its end at the top, with lines every 5 minutes for
  an episode and every 30 for a film. The line is solid while playing and
  dashed while paused. Each seek is a step labelled with its cause (Skip
  Intro, Skip Credits, Jump back, Jump forward) or, for one on the seek bar,
  how far it went (Seek +20:00, Seek −5:00); the end of the title is labelled
  Finished. Buffering and player errors are marked on the line where they
  happened, so a damaged part of a file shows. **Per-viewer positions** adds
  each viewer's own position line, so a player that fell behind shows.
- **Streams:** one row per stream, coloured by delivery method, with a mark
  for each processing step.
- **Viewers:** one row per viewer, coloured by role (host, co-host or
  viewer), with their roles summarised under the name, and buffering,
  loading and time away from Discord marked on the row.
- **Data delivered:** the data delivered to the players by source (server,
  Discord cache, peers), with the required bitrate as a dashed line: the
  combined bitrate of the streams the viewers were on while the session
  played.
- **Player health:** each viewer's sync offset with the ±2 second tolerance,
  each viewer's buffer on a fixed scale of 0 to 150 seconds (the most a
  player fetches ahead) with a line every 30 seconds and the 10 second low
  mark, and dropped frames, with a line for every viewer once any of them
  dropped a frame.

Each section's colour key is under its own rows.

Hover over or tap the chart for a line across every row and the values at
that moment, in sections: **Session** (playback and the position);
**Streams**; **Data delivered** by source and the required bitrate;
**Viewers** (each viewer's role, status, stream, sync offset, buffer and
dropped frames); and **Events** near that moment, each with the mark it has
on the chart and the one under the pointer highlighted. The readout keeps
its place while the pointer moves along a row. On a phone the readout sits under the chart, each viewer on two
lines. Hover any bar, line or mark for its details. Where labels would
overlap, as on a phone, some are left to their mark's hover.

## Statistics

Trends over the last 24 hours, 7 days, 30 days, 90 days, a year, all time, or
a period of your own under **Custom…**: the last so many hours or days, a
date range (21 September to 1 October, both whole days), or a time range.
Three days or less is shown by the hour. Days and hours are in your local
time, and a session counts on the day it started.

At the top: sessions, watch time, users (with launches and requests), data
delivered (with the share served by Discord's cache), the share of streams
transcoded, and buffering. The charts follow in six groups, each linked from
the bar under the figures:

- **Usage.** Sessions and watch time per day; sessions by hour of the day,
  by weekday, and both together as a grid (darker cells had more sessions).
- **Users, titles and servers.** The most active users, the most watched
  titles and the most active Discord servers, by watch time, and watch time
  per day by server.
- **Data delivery.** Data delivered per day by source, the server's upload
  (below), and peer-to-peer sharing: the top sharers by data sent to other
  viewers, and the largest transfers between two viewers.
- **Streams and processing.** Streams per day by delivery method, transcode
  reasons (the most common first, and per day: the three most common each in
  a colour, the rest together), the median time from FFmpeg start to the
  first playable segment per day, **Processing times** (for each processing
  step and mode: how many completed and failed, with the median, the 95th
  percentile and the longest), and **Titles with stream corrections**: titles whose audio was
  padded, whose stream ended before the duration Plex reports, whose
  subtitles were burned in, or whose HDR was tone-mapped to SDR, with how
  often and a link to the latest session.
- **Playback quality.** Buffering and player errors per day, and
  **Buffering and transcodes by client**: each viewer's session by the client
  they finished it on, with sessions, watch time, buffering, buffering per
  hour watched, how many streams were made for one viewer, and how many of
  those were transcoded.
- **Launches and requests.** Activity launches per day, and title requests
  per day by result.

**Server upload** is everything the server's port sent in the period: video,
playlists, subtitles and the Activity page, measured as it leaves. The page
says since when.

- In total, on average while something played, at the 95th percentile, and
  in its busiest minute, in Mbps and MiB/s.
- The same by number of viewers, with **Relative to bitrate**: what the
  server sent over the bitrate of the one stream playing. Use it to set the
  qBittorrent manager's `MAX_UPLOAD_MIB`, `MIN_UPLOAD_MIB`,
  `THEATER_SHARED_BASE` and `THEATER_EXTRA_VIEWER_FACTOR`; see
  [qBittorrent Manager API](qBittorrent-Manager-API#setting-it-from-your-own-figures).
- What was sent, and the busiest minute, per hour or day.

**Show table** switches any chart to a table of its values.

## Users

At the top, the most active users of the last 30 days by watch time. Below,
everyone who has used the Activity, most recently active first, with their
Discord user ID under the name: when they were last seen, sessions, sessions
hosted, launches, watch time, data received, data sent to other viewers,
buffering, requests, and the last title they watched.

Select a user for their page. At the top: sessions, watch time, sessions
hosted, launches, their Discord user ID, when they were first and last seen,
data received with its split by source, data sent to other viewers,
buffering (with events per hour watched), requests, and their time as host,
co-host and viewer. The sections follow in this order:

- **Trends.** Watch time, sessions and buffering per week, over the last
  12 weeks.
- **Sessions.** Every session they were in, with their role, watch time,
  data and buffering.
- **Clients.** Every client they used, the formats its player decodes (such
  as HEVC, 10-bit, 4K, AV1 or E-AC3), how many sessions it was used for, and
  when it was first and last used.
- **Servers and channels** they used.
- **Peer-to-peer sharing.** Who they sent video to and received it from.
- **Requests.** Every title they requested.

## Discord Servers

Watch time per day by server. Then each Discord server the Activity was used
in, and each of its channels: launches, joins, users, sessions and time
played. A channel's users show by name, most recent first; past ten, the
first eight show with **Show all**. On a phone each channel is a card with its
users across the full width. Below, every launch and join, newest first.

Servers and channels show by name, here and on every page. A server's name is
learned when someone opens the Activity in it, and a channel's when the
Activity runs in it. Until then the ID shows; hover a name for its ID. To
match an ID yourself, turn on Developer Mode in Discord, then right-click the
server or channel and choose **Copy ID**.

## Requests

Title requests per day by result. Below, every title requested through Seerr
from the Activity: who requested it, the title, the seasons, and the result;
a failed request shows the HTTP status and the error. **Status now** asks
Seerr for the request's current state, so a request that was approved,
declined or made available since shows as such.

## Caches

- **Storage used.** Total storage used by the server, with each cache's
  size, share of the total, limit and number of items, largest first.
- **Discord cache efficiency.** How much of the video the players downloaded
  was served by Discord's cache instead of the server, over the last 24
  hours, the last 7 days and all time, for each title, and per day by source.
- **Each cache the server keeps**, with its size against its limit, its
  location, its retention, and what it holds: direct-play segments, FFmpeg
  stream segments, artwork, title details, text subtitles, image subtitles,
  seek-bar previews and subtitle fonts.

## Logs

The server's log files, newest first. Filter by level, tag or text, and show
the last 200 to 5000 lines. **Follow** refreshes every 5 seconds. Lines
reported by a viewer's player are labelled with that player. Times are in
your local time; each file holds one day in UTC. Opened from a session in
History, it shows only the lines written during that session; **Show the
whole file** clears that.

## System

- **Status.** Version, uptime, memory and platform.
- **Server load.** Recorded each minute and shown over the last hour, 6 hours,
  24 hours, 7 days, 30 days or 90 days, or a custom period (**Custom…**: the
  last so many hours or days, a date range or a time range). Drag across any
  chart with the mouse to zoom into that stretch, down to 10 minutes in
  one-minute steps; **Zoom out** goes back one zoom and **Reset zoom** to the
  period chosen. The period shown and its step are above the figures. The
  charts: CPU usage of the machine and of the bot
  process, memory usage of the machine and of the bot process, streams and
  viewers, the server's upload, and the load average (Linux only, with a line
  at the number of CPU cores). Figures above the charts give each measure's
  average (the latest, for the bot's memory) and its peak, with when it
  occurred.
- **History database.** Where `admin.sqlite` is, its size, what it holds and
  the period it covers. **Download database** saves a copy. **Delete old
  history** deletes everything older than the number of days you enter:
  **Preview deletion** shows what would be deleted, and nothing is deleted
  until you confirm. Sessions in progress are never deleted.
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
- **Each stream:** its delivery method and the reason, its tracks, quality
  and bitrate, who it was made for, and when it started and ended.
- **Each event:** plays, pauses and seeks with who did them, people joining
  and leaving, switching away from the Discord window, track and quality
  changes, changes of host and requests for it, how long players took to
  load, buffering and errors, and titles whose stream needed a correction.
- **Each processing step:** file analysis, stream setup, the first segment,
  full-file processing, subtitle extraction and conversion, external
  subtitles and seek previews, with how long each took and whether it
  completed.
- **Data by the minute:** what a session's players had from the server,
  Discord's cache and other viewers, each minute.
- **Where in the title:** the session position, and each player's, every 10
  seconds.
- **Player health:** each player's report every 10 seconds: sync offset,
  buffer, media element buffer, frames rendered and dropped, data by
  source, peers, playback rate and memory.
- **Usage:** each launch of the Activity and each person joining a room.
- **Upload:** what the server's port sent, each minute, with how many were
  watching and the bitrate of the streams playing.
- **Server load:** each minute, the machine's CPU and memory, the bot
  process's CPU and memory, the load average, and the streams and viewers.
- **Names:** the names of Discord servers and channels.
- **Requests:** each title requested through Seerr.

Nothing is deleted unless you delete it on the System page. Without
`ADMIN_PASSWORD`, nothing is recorded. Back up `admin.sqlite` with the rest of
the data folder. See [Updating and Backups](Updating-and-Backups).

Updating keeps everything already recorded: the database is upgraded in
place the first time the new version starts, and new tables and columns are
added without changing what is there.

## Exports and API

A signed-in browser can read everything as files or JSON.

| Path | Returns |
|---|---|
| `/api/overview` | Every room in progress |
| `/api/history` | Sessions, newest first. `?q=` searches. `?before=<id>` is the next page. |
| `/api/history/<id>` | One session: its viewers, streams and events |
| `/api/people`, `/api/people/<id>` | Users, and one user |
| `/api/places` | Each Discord server and its channels |
| `/api/names` | The names of Discord servers and channels, by ID |
| `/api/usage` | Launches and joins, newest first |
| `/api/requests` | Title requests, with Seerr's current status |
| `/api/caches` | Each cache and what it holds |
| `/api/graphs` | Statistics by hour or day, and the server's upload. `?days=` is the period: 30 unless given, 0 for all time. `?hours=` is the last so many hours instead, and `?from=` with `?to=`, in milliseconds since 1970, a period of its own. `?tz=` is the time zone the days, hours and weekdays are in, such as `Europe/London`: UTC unless given. |
| `/api/system-load` | The server's load by minute. `?hours=` or `?days=` is the period up to now (24 hours unless given, at most 90 days), or `?from=` and `?to=` (epoch milliseconds) a period within the last 90 days, 10 minutes at the least. |
| `/api/export/<list>.csv`, `.json` | `history`, `people`, `usage` or `requests`, as a file. `?q=` is the list's search. At most 200,000 rows. |
| `/api/export/admin.sqlite` | A copy of the whole history database |

CSV files are UTF-8 and open in a spreadsheet. Text that a spreadsheet would
run as a formula is written with a `'` in front.

## Next

→ [Configuration Reference](Configuration-Reference)
