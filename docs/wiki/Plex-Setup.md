# Plex Setup

What Plex needs to have configured, and how to get the tokens.

---

## The three Plex credentials

This project can use up to three different Plex credentials. Only the first is
required, and they are genuinely different things — mixing them up is a common
cause of "Discover pages are blank".

| Credential | Whose | Required? | What it does |
|---|---|---|---|
| `PLEX_TOKEN` | Server owner | **Yes** | Browses your library and starts streams for the room |
| `PLEX_ACCOUNT_TOKEN` | Server owner | No | Fetches Plex Discover details for titles you do *not* own, and signs in to Seerr |
| Per-user linked token | Each viewer | No | Syncs that person's own progress, watched status and Watchlist |

### Why two owner tokens?

`PLEX_TOKEN` is a **server** token. The Plex *cloud* rejects it. So if you only
set `PLEX_TOKEN`, searching Plex Discover returns results, but opening one shows
an empty detail page — there is no summary, no cast, nothing.

`PLEX_ACCOUNT_TOKEN` is an **account** token from plex.tv, which the cloud
accepts. Set both and everything works.

---

## Getting `PLEX_TOKEN`

Follow Plex's own guide:
[Finding an authentication token / X-Plex-Token](https://support.plex.tv/articles/204059436-finding-an-authentication-token-x-plex-token/).

The short version:

1. Open any item in Plex Web.
2. Click the **⋯** menu → **Get Info** → **View XML**.
3. Look at the URL of the page that opens. The `X-Plex-Token=` query parameter
   at the end is your token.

> [!WARNING]
> This token grants full access to your Plex server. Keep it in `.env`, never in
> a screenshot, an issue, or a commit.

## Getting `PLEX_ACCOUNT_TOKEN`

This one takes more finding than the server token. Almost everything Plex Web
sends goes to your own server, with the server token. The account token only
goes with requests to Plex's own online services, so the way to catch it is to
make Plex Web look something up there: open a title that is **not** in your
library.

### Firefox

1. Sign in at [app.plex.tv](https://app.plex.tv).
2. Press **F12** (**Cmd+Option+I** on a Mac) and open the **Network** tab,
   with the **All** filter selected.
3. Search Plex for a film you don't have and open it, so its page shows a
   description. If the Network list is empty because the tools were opened
   after the page loaded, reload the page (**F5**).
4. Click the **magnifying glass** in the Network toolbar (or press
   **Ctrl+Shift+F**, **Cmd+Shift+F** on a Mac) and search for a few words of
   the description, for example `Odysseus, the legendary King of Ithaca` on
   *The Odyssey*.
5. Open the result. That is the request that fetched the description from
   Plex's servers. In its **Headers**, find `X-Plex-Token`, in the request
   address or among the request headers. Its value is your account token.

### Chrome, Edge, Brave and Opera

The same steps. In the **Network** panel, the search is the **magnifying
glass** in its toolbar (or **Ctrl+F**, **Cmd+F** on a Mac, with the panel
focused). Click the matching request, then **Headers**, and look under
**Request URL** and **Request Headers** for `X-Plex-Token`.

### Safari

Turn on the developer tools first: **Safari → Settings → Advanced → Show
features for web developers** (**Show Develop menu in menu bar** on older
versions). Then **Develop → Show Web Inspector → Network**, open a title you
don't have, and use the filter below.

### Any browser: filter by address

Instead of searching for the description, type `provider.plex.tv` into the
Network panel's filter box. What's left are requests to Plex's online
services (`discover.provider.plex.tv`, `metadata.provider.plex.tv`), and they
carry the account token, so any of them will do.

### From the browser console

Plex Web also keeps the account token in the browser. On app.plex.tv, open the
developer tools' **Console** and run:

```js
localStorage.getItem("myPlexAccessToken")
```

If that prints `null`, use one of the Network methods above.

### Checking it

Put the value in `.env` as `PLEX_ACCOUNT_TOKEN` and restart. Then search the
Activity for something you don't own and open it: a description and cast mean
the account token works. A blank page means it is the server token, or a
token that has stopped working.

Account tokens are tied to your Plex sign-in. Signing out of all devices, or
changing your Plex password and signing devices out, ends them, so if
Discover pages or **Request** go blank later, get a new one the same way.

> [!WARNING]
> The account token is your whole Plex account, not just one server. Keep it in
> `.env`, out of screenshots, issues and commits, and don't paste it into
> anything you don't trust.

---

## Setting `PLEX_URL`

This is the address the **container** uses to reach Plex, which is not
necessarily the address *you* use.

| Your setup | Use |
|---|---|
| Plex on another machine | Its LAN address — `http://192.168.1.50:32400` |
| Plex in Docker on the same host | The Plex container name — `http://plex:32400` — if they share a network |
| Plex on the same host, not in Docker | `http://host.docker.internal:32400`, or the host's LAN address |

> [!IMPORTANT]
> **Do not use `http://localhost:32400`.** Inside the container, `localhost`
> means the Activity container itself, not your Plex server. This is the single
> most common cause of an empty library.

Test it from inside the container once running:

```bash
docker compose exec plex-discord-theater wget -qO- "$PLEX_URL/identity?X-Plex-Token=$PLEX_TOKEN"
```

XML back means the address works.

---

## Plex settings that matter

### Transcoding must work

The Activity streams HLS to browsers, which means Plex's transcoder runs for
every stream. Check **Settings → Transcoder** on your Plex server.

If you have a Plex Pass and supported hardware, enable **Use hardware
acceleration when available**. Without it a single 1080p transcode can occupy
several CPU cores.

With [Direct Stream](Configuration-Reference#direct_stream), on by default, Plex
copies the video whenever a player can decode it and only converts the audio,
which costs the transcoder very little. Re-encodes still happen for the cases listed there,
so hardware acceleration is still worth having.

With the [ffmpeg engine](FFmpeg-Engine), this container makes the streams
instead, and Plex's transcoder runs only for the streams ffmpeg leaves to it.
Keep it working for those.

### HEVC encoding

For [HEVC transcodes](Configuration-Reference#hevc_transcode), on by default:
enable **Enable HEVC video encoding** under **Settings → Transcoder**. It needs
Plex Pass and hardware encoding (Intel or NVIDIA); without it Plex keeps sending
H.264. Copying HEVC files needs none of this.

![Settings → Transcoder, with hardware acceleration and HEVC encoding on](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/plex-transcoder.png)

### Let Plex treat the bot as local

Plex counts the bot as a remote player unless the network it connects from is
listed under **Settings → Network → LAN Networks**, and then also holds its
streams to your **remote streaming** limits. Plex's own log says `(WAN)` next to the bot's requests when that is
happening.

Add the bot's network there, for example the Docker network's subnet, or your
LAN's if the container uses the host network.

![Settings → Network → LAN Networks](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/plex-lan.png)

### With the ffmpeg engine

- **Library paths.** ffmpeg opens each file at the path Plex reports for it,
  which is the folder added under **Settings → Libraries**. Mount the library
  into this container at the same path, or map Plex's paths onto yours with
  [`MEDIA_PATH_MAP`](FFmpeg-Engine#library-paths).
- **What Plex shows.** ffmpeg's streams appear in Plex's dashboard as
  **Plex Discord Theater**, under `PLEX_TOKEN`'s account, labelled
  **Direct Play** at the file's own bitrate. Plex can't stop them: stop them
  from the Activity. See
  [Plex's dashboard, Tautulli and Tracearr](FFmpeg-Engine#plexs-dashboard-tautulli-and-tracearr).

### Intro and credit markers

**Skip Intro** and **Skip Credits** buttons only appear if Plex has detected
markers for that episode.

- **Settings → Library → Generate intro video markers** — set to run for your
  libraries.
- Each library has its own switches too: **Edit → Advanced → Enable intro
  detection** and **Enable credits detection**.
- Marker detection runs as a background task and takes a while on a large
  library. The buttons appear as it completes.

![A library's Advanced settings, with intro and credits detection on](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/plex-library-advanced.png)

Credit markers also decide when a title counts as watched: at the first credits
marker or, for titles without one, at your server's **Video played threshold**
(**Settings → Library**, 90% by default).

### Preview thumbnails

The images that appear when you drag the scrub bar come from Plex's **video
preview thumbnails**.

- **Settings → Library → Generate video preview thumbnails.**
- This is expensive to generate and consumes disk space, but it is what makes
  scrubbing usable.
- Without it, scrubbing still works — you just get no preview images.

> **Note on long films.** Preview data for a six-hour video can run to tens of
> megabytes. The client fetches it in four passes: a sparse first set of frames
> at once, then denser ones as the video buffers, which pause whenever the
> playback buffer runs low. Scrubbing has pictures almost at once, and your
> stream is not interrupted — the remaining frames simply arrive a bit later.

---

## Checking it worked

Start the stack ([Installation](Installation)) and run:

```bash
docker compose logs | grep Config
```

You should see a line showing which integrations are active. Then open the
Activity — if the home screen shows your libraries, Plex is wired up correctly.

If the library is empty, go to
[Troubleshooting](Troubleshooting#the-library-is-empty).

---

## Next

→ [Installation](Installation) · [Configuration Reference](Configuration-Reference)
