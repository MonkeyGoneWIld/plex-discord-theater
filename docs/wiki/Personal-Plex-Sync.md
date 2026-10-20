# Personal Plex Sync

Optional. Link your own Plex account so watch parties count towards *your* Plex
history, not just the server owner's.

You do not need this to watch anything.

---

## What it is

The Activity always streams using the **server owner's** Plex connection. That
is what makes the library appear and the video play.

Linking your own account is a separate, additional thing: it lets the Activity
read and write *your* personal Plex data while you watch on someone else's
server.

## What gets synced

- Watched and unwatched status
- Resume positions and Continue Watching progress
- Progress earned during watch parties
- Your Plex Universal Watchlist

Sync is **bidirectional**. Your existing Plex history is imported when you link,
and progress you earn here is written back to Plex.

It runs automatically. There is also a **Sync now** button if you want to force
a refresh.

## In a watch party

Every linked participant gets progress on their own account — not just whoever
is hosting. Four linked people watching an episode together all get that episode
marked in their own Plex.

Anyone who sets **Settings → Watch history → Only when I host** gets nothing
saved or synced from parties they join as a viewer.

A title is marked watched once playback reaches its credits marker, or Plex's
**Video played threshold** when it has none.

Unlinked people are not left out; their watched status is simply tracked locally
by the Activity instead.

---

## Linking your account

1. Press **Link Plex** in the header.
2. Choose **Continue with Plex**.
3. Sign in on **Plex's own page**.

![Account sync, before linking](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/plex-link.png)

Your Plex password never passes through this application. It goes to Plex, and
the Activity receives a token.

## What changes once you link

- A **Watchlist** tab appears, backed by your Plex Universal Watchlist.
- You can add and remove titles from any detail page.
- The Watchlist tab **replaces** the local History tab. Your progress is still
  there — through Continue Watching and the watched controls.
- Marking things watched writes through to Plex.

![The Watchlist tab for a linked Plex account](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/watchlist.jpg)

---

## Security

Personal tokens are **encrypted at rest** in the server's database.

The encryption key comes from `PLEX_LINK_SECRET` if the administrator set one.
If they did not, it falls back to the Discord client secret — which means that
if the admin ever rotates that secret, everyone has to relink. Admins: see
[`PLEX_LINK_SECRET`](Configuration-Reference#plex_link_secret).

## Unlinking

Press **Plex linked** in the header and choose **Disconnect**. The stored token
is removed. Anything already written to your Plex account stays there, as you
would expect. **Sync now** in the same box pulls your Plex history again.

![Account sync, once linked](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/plex-linked.png)
