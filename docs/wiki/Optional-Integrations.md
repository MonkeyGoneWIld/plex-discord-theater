# Optional Integrations

These services add information and features to the Activity. All of them are
optional: anything you don't configure hides its row, tab or button, and
nothing else is affected.

| Integration | Setting | Adds | Set it up when |
|---|---|---|---|
| [Plex Discover](#plex-discover) | `PLEX_ACCOUNT_TOKEN` | Pages for titles outside your library | Always |
| [TMDB](#tmdb) | `TMDB_API_KEY` | Collections, **More Like This**, and cast and crew pages | Always; the key is free |
| [TVDB](#tvdb) | `TVDB_API_KEY` | Missing-episode lists numbered as Sonarr numbers them | You use Sonarr |
| [Seerr](#seerr) | `SEERR_URL` | **Request** buttons | You run Overseerr or Jellyseerr |
| [qBittorrent manager](qBittorrent-Manager-API) | `QBT_MANAGER_API_KEY` | Upload limits that follow the room | You run plex-qbt-manager |

## Check what is on

```bash
docker compose logs plex-discord-theater | grep Config
```

```text
[Config] ✓ TMDB   ✓ TVDB   ✓ Requests   ✓ Discover   …
```

`✓` means configured; `·` means not configured. Settings take effect when the
container is recreated with `docker compose up -d`.

## Plex Discover

**Setting:** `PLEX_ACCOUNT_TOKEN`

Search covers both your library and Plex Discover. Opening a title that isn't
in your library needs the owner's plex.tv account token, because Plex's online
services reject the server token in `PLEX_TOKEN`. Without it, those pages have
no description or cast.

See [Plex Setup](Plex-Setup#get-plex_account_token) to get the token.

## TMDB

**Setting:** `TMDB_API_KEY` ·
**Get a key:** [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api), free

- **Also in this collection** lists a film's whole collection. Titles you
  don't have are marked **Not in library**, and can be requested when Seerr is
  set up. Without a key, the row lists only titles you have.
- **More Like This** lists TMDB's recommendations, titles you have first.
  Without a key, the row is hidden.
- **Cast and crew pages** list each person's titles in your library first,
  followed by the rest of their filmography.

To get a key, create a free TMDB account, open **Settings → API**, and
request a v3 API key. Approval for personal use is usually immediate.

## TVDB

**Settings:** `TVDB_API_KEY`, and `TVDB_PIN` for a subscriber key ·
**Get a key:** [thetvdb.com/api-information](https://thetvdb.com/api-information), free

Season pages list the episodes you're missing and the ones not yet aired. TVDB
provides that list in the same numbering Sonarr uses. Without TVDB, the list
comes from TMDB, whose season numbering differs from Sonarr's for some shows,
so a missing episode can appear in the wrong season and a request for it can
fail.

A free project key needs no PIN. A subscriber key also needs `TVDB_PIN`.

## Ratings

IMDb, TMDB and Rotten Tomatoes critic and audience ratings come from Plex's own
metadata, for films and for episodes. No key is needed. For titles outside
your library, set `PLEX_ACCOUNT_TOKEN`.

## Seerr

**Setting:** `SEERR_URL` ·
**Needs:** [Overseerr](https://overseerr.dev/) or
[Jellyseerr](https://github.com/fallenbagel/jellyseerr), and `PLEX_ACCOUNT_TOKEN`

```yaml
      SEERR_URL: "https://requests.example.com"
      PLEX_ACCOUNT_TOKEN: "your-plex-account-token"
```

Adds **Request** buttons to titles that aren't in your library. The server
signs in to Seerr as you, with `PLEX_ACCOUNT_TOKEN`, so no Seerr API key is
needed. Without the account token it tries `PLEX_TOKEN`, which plex.tv
normally rejects, so set both.

Every request is made from your Seerr account, so Seerr can't tell which
Discord user asked, and per-user request limits don't apply.

See [Requesting Titles](Requesting-Titles) for how viewers use it.

## Next

→ [qBittorrent Manager API](qBittorrent-Manager-API)
