# Admin Page

A page for the server's owner that shows what the bot is doing right now:
every room, who is in it, each stream and why it is copied or re-encoded, the
server's logs and its settings. It runs on a port of its own, apart from the
Activity, and only once a password is set.

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
  - when they joined.

A room on two streams, such as a viewer whose player can't decode the host's
10-bit HEVC and is given an 8-bit stream of their own, shows both streams.

### Logs

The server's log files from `LOG_DIR`, newest first. You can filter by level,
tag or text, and show the last 200 to 5000 lines. **Follow** refreshes every
5 seconds. Lines sent by a viewer's player are labelled with that player.
Times are UTC.

### Settings

The version, Node.js, uptime and memory. Then every setting the server reads,
with its value, or "Not set" for one left at its default.

The page shows what is happening now. It doesn't yet keep a history of past
sessions.

## Next

→ [Local Development](Local-Development)
