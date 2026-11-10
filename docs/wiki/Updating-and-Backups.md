# Updating and Backups

How to update the server, change its settings, roll back, and back up its
data.

## Update

### With the published image

```bash
docker compose pull
docker compose up -d
```

The `latest` tag always points to the newest release. If your compose file
pins a version, such as `2.0.0`, change it to the new version first.

### From source

```bash
cd plex-discord-theater
git pull
docker compose up -d --build
```

`--build` rebuilds the image, including the player that Discord loads.

### After updating

1. Run `docker compose ps`. After about 30 seconds the container should show
   `healthy`. If it doesn't, see
   [Troubleshooting](Troubleshooting#the-container-is-unhealthy-or-keeps-restarting).
2. Ask anyone who had the Activity open to close it and open it again, which
   loads the new version.

Restarting the server interrupts watch parties in progress for a few seconds.
Players reconnect on their own and the stream restarts where it was. Sign-ins
are stored for 24 hours and survive a restart, so nobody has to authorize the
Activity again. To avoid interrupting anyone, update between watch parties.

## Change a setting

Edit the value in your compose file or `.env`, then run:

```bash
docker compose up -d
```

Compose recreates the container with the new values. `docker compose restart`
does not: it restarts the container with the values it already had.

Every setting is described in the
[Configuration Reference](Configuration-Reference).

## Roll back

With the published image, set the previous version in your compose file, for
example `ghcr.io/monkeygonewild/plex-discord-theater:2.0.0`, then run
`docker compose up -d`.

From source:

```bash
git checkout v2.0.0
docker compose up -d --build
```

The data volume isn't changed by either. Back it up before updating if you
may want to roll back.

## What the server stores

Everything is in the data folder, `/data` in the container. The compose file
keeps it in the `app-data` volume.

| File or folder | Holds | Back it up |
|---|---|---|
| `plex-accounts.sqlite` | Linked Plex accounts, with their tokens encrypted | Yes |
| `watch-history.sqlite` | The Activity's watch history and history settings | Yes |
| `instances.sqlite` | Each Activity window's channel and host | Optional |
| `sessions.sqlite` | Sign-ins, each valid for 24 hours | Optional |
| `detail-cache.sqlite` | Title details from Plex Discover, TMDB and TVDB | No: cache warming rebuilds it |
| `thumb-cache.sqlite` | Artwork, up to `THUMB_CACHE_MAX_SIZE` (10 GB) | No: fetched again when needed |
| `subtitles.sqlite` | Text subtitles read out of media files | No |
| `previews/` | Seek-bar previews made by the FFmpeg engine, up to `FFMPEG_PREVIEWS_MAX_GB` (20 GB) | No |
| `subtitles-pgs/` | Picture subtitles read out of media files by the FFmpeg engine, up to `FFMPEG_PGS_MAX_GB` (2 GB) | No |
| `subtitle-fonts/` | Fonts read out of media files for styled subtitles | No |
| `stream-cache/` | Copied films while they play | No: emptied at every start |
| `diagnose/` | Reports from the FFmpeg diagnosis script | No |
| `logs/` | The server's logs | No |

Rooms are kept in memory and aren't stored.

The server tidies the folder a minute after it starts and then once a day. It
deletes diagnosis reports older than 14 days, picture subtitles nobody has
played for 60 days, and empty folders left in the stream cache.

### Logs

The server writes a log file per day. A file that reaches 64 MB continues in a
new one, and logs are kept for 7 days. `LOG_MAX_FILE_MB` and
`LOG_RETENTION_DAYS` change these. To copy the logs out of the container:

```bash
docker cp plex-discord-theater:/data/logs ./logs
```

### Disk space

Streams are the largest use of disk. Copied films are kept in memory up to
6 GB for all streams together, and on disk after that, at up to about 11 GB an
hour for a 25 Mbps film. The FFmpeg engine writes its streams to the same
folder. Each stream's files are removed when it ends. If the data volume is on
a small or slow disk, move them to an SSD with `STREAM_CACHE_DIR`; see
[Stream caches](Configuration-Reference#stream-caches).

To see how much the volume uses:

```bash
docker system df -v | grep app-data
```

## Back up

The data that can't be rebuilt is linked Plex accounts and watch history.
The rest is cache. This backup leaves out the largest caches.

1. Find the volume's full name. Compose adds the project name, which is usually
   the name of the folder that holds the compose file:

   ```bash
   docker volume ls | grep app-data
   ```

2. Stop the server, archive the volume, and start the server again. Replace
   `theater_app-data` with the name from step 1:

   ```bash
   docker compose stop
   docker run --rm -v theater_app-data:/data -v "$PWD:/backup" alpine \
     tar -czf /backup/theater-data.tar.gz \
     --exclude=stream-cache --exclude=previews --exclude=subtitles-pgs \
     --exclude='thumb-cache.sqlite*' -C /data .
   docker compose start
   ```

This writes `theater-data.tar.gz` to the current folder.

Keep a copy of your compose file and `.env` with the backup, somewhere private:
they hold your Discord secret and Plex tokens.

> [!IMPORTANT]
> Linked Plex tokens are encrypted with `PLEX_LINK_SECRET`, or, when that isn't
> set, with `DISCORD_CLIENT_SECRET`. Restored with a different value, the
> tokens can't be read, and everyone has to link their Plex account again.
> Set [`PLEX_LINK_SECRET`](Configuration-Reference#plex-accounts) and keep it
> with your backups.

## Restore

```bash
docker compose stop
docker run --rm -v theater_app-data:/data -v "$PWD:/backup" alpine \
  sh -c "rm -rf /data/* && tar -xzf /backup/theater-data.tar.gz -C /data"
docker compose start
```

The caches left out of the backup fill again as they are used.

## Move to another machine

1. Back up the data volume on the old machine.
2. Copy the backup, your compose file and `.env` to the new machine.
3. On the new machine, run `docker compose up -d` once to create the volume,
   then restore the backup into it.
4. For the [FFmpeg engine](FFmpeg-Engine#set-it-up), mount the library and GPU
   again on the new machine.
5. Point your domain or tunnel at the new machine.

If the public address changes, update the URL mapping in the Discord Developer
Portal, and `REDIRECT_URI` and `ALLOWED_ORIGINS`.

## Next

→ [Admin Page](Admin-Page)
