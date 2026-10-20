# Installation

The full walkthrough. If you have not already, skim
[Requirements](Requirements) first — it will save you backtracking.

**Rough order:** create the Discord app → get Plex tokens → configure → start →
launch.

---

## 1. Prerequisites

- [Discord Application Setup](Discord-Application-Setup) done, and you have your
  **Application ID** and **Client Secret**
- [Plex Setup](Plex-Setup) done, and you have your **`PLEX_TOKEN`**
- A public HTTPS address pointing at the machine that will run this

## 2. Choose how to run it

**Use the published image** — the usual choice, and the one Portainer and Dockge
users want. Nothing to clone; the compose file in the
[README](https://github.com/MonkeyGoneWIld/plex-discord-theater#3-deploy) is
complete and sets every value inline.

```yaml
image: ghcr.io/monkeygonewild/plex-discord-theater:latest
```

**Or build from source**, which is what the rest of this page assumes:

```bash
git clone https://github.com/MonkeyGoneWIld/plex-discord-theater.git
cd plex-discord-theater
```

## 3. Configure

```bash
cp .env.example .env
```

Open `.env` and fill in the six values that matter. Everything else is optional
and documented in the [Configuration Reference](Configuration-Reference).

```env
DISCORD_CLIENT_ID=your_application_id
DISCORD_CLIENT_SECRET=your_client_secret

PLEX_URL=http://192.168.1.50:32400
PLEX_TOKEN=your_plex_token

REDIRECT_URI=https://watch.example.com
ALLOWED_ORIGINS=https://watch.example.com
```

Three things to get right:

- **`PLEX_URL`** must be reachable *from inside the container*. Not `localhost`.
  See [Plex Setup](Plex-Setup#setting-plex_url).
- **`REDIRECT_URI` and `ALLOWED_ORIGINS`** must both exactly match the public
  HTTPS address you mapped in the Discord Developer Portal — including
  `https://` and with no trailing slash.
- **No quotes** around values in `.env`, and no spaces around the `=`.

## 4. Start it

```bash
docker compose up -d --build
```

The first build compiles a native module and takes a few minutes. Later starts
are fast.

Check it came up:

```bash
docker compose logs | grep Config
```

You should see something like:

```text
[Config] ✓ TMDB   ✓ TVDB   ✓ Requests   ✓ Discover   · VPS relay (P2P mode)   ✓ HEVC   ✓ Direct Stream for files averaging up to 20000 kbps   · Guild allowlist (open to any Discord server)
[Config] films being played: copied ones kept until the stream ends, 6144 MB in memory (DIRECT_STREAM_MEMORY_MB) and the rest on disk at /data/stream-cache (STREAM_CACHE_DIR); re-encoded ones 2048 MB in memory (TRANSCODE_CACHE_MB), the rest on Plex's disk
[Config] playback engine: Plex
```

A `✓` means that feature is on, a `·` means it is off or not configured.
HEVC and Direct Stream are on unless set to `0`. Every one of them is
optional — see [Optional Integrations](Optional-Integrations) and
[Direct Stream and HEVC](Configuration-Reference#direct-stream-and-hevc). The
second line says how much memory and disk the films being played may use; see
[Stream caches](Configuration-Reference#stream-caches). The third says who
makes the streams: Plex, unless you set up the [ffmpeg engine](FFmpeg-Engine).

Then check it is healthy:

```bash
docker compose ps
```

The container should report `healthy`. The health check probes Plex, so
`unhealthy` means the container cannot reach your Plex server — go back to
step 3.

## 5. Expose it over HTTPS

Discord will not load an Activity over plain HTTP. Point your chosen HTTPS
endpoint at the container's port (`3000` by default).

### Cloudflare Tunnel

The easiest route, and it needs no port forwarding:

```bash
cloudflared tunnel --url http://localhost:3000
```

That prints a temporary `https://….trycloudflare.com` address. Fine for a first
test, but it changes on every restart and you would have to update the Discord
URL mapping each time. For anything ongoing, create a
[named tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-local-tunnel/)
with a stable hostname.

### A reverse proxy

If you already run nginx, Caddy or Traefik, proxy your chosen hostname to
`http://<host>:3000`. Two requirements:

- **WebSocket upgrade must pass through.** Room sync runs over a WebSocket; if
  upgrades are blocked, everyone sits on "Reconnecting…".
- **Do not buffer responses.** Video segments stream; buffering them adds
  latency and can stall playback.

A minimal nginx location block:

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_buffering off;
}
```

> [!NOTE]
> The application sets `trust proxy` for exactly one hop. Run it behind a single
> reverse proxy, not a chain, and do not expose port 3000 directly to the
> internet at the same time.

## 6. Launch in Discord

1. Join a voice channel.
2. Click the **rocket icon**.
3. Pick your application.
4. **Invite to Activity** brings other channel members into the same room.

<img src="https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/discord-launch.png" alt="The Activity's launch card in Discord" width="320">

Remember the [25-member limit](Discord-Application-Setup#the-25-member-limit) on
unverified apps, and that friends need to be
[app testers](Discord-Application-Setup#adding-app-testers).

---

## Running the published image instead

If you would rather not build from source, a container image is published to
GitHub Packages:

```bash
docker pull ghcr.io/monkeygonewild/plex-discord-theater:1.2.2
```

The image is generic. Your `DISCORD_CLIENT_ID` is injected into the page by the
server at request time, so the same image works for every deployment — fill in
`.env` exactly as above and start it without `--build`.

---

## Verifying everything works

Work down this list. Each step depends on the one above it.

| Check | How | If it fails |
|---|---|---|
| Container is up | `docker compose ps` shows `healthy` | [Container will not start](Troubleshooting#the-container-will-not-start) |
| Plex is reachable | Library appears on the home screen | [Library is empty](Troubleshooting#the-library-is-empty) |
| HTTPS works | Your public URL loads in a browser | Check your proxy or tunnel |
| Discord can load it | Activity appears in the rocket menu | [Activity does not appear](Troubleshooting#the-activity-does-not-appear-in-the-rocket-menu) |
| Playback works | A title plays | [Video will not play](Troubleshooting#video-will-not-play) |
| Sync works | A second person sees your pauses | [Reconnecting](Troubleshooting#stuck-on-reconnecting) |

---

## Next

→ [Configuration Reference](Configuration-Reference) ·
[Optional Integrations](Optional-Integrations) ·
[Using the Activity](Using-the-Activity)
