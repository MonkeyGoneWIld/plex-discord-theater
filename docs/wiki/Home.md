# Plex Discord Theater

Plex Discord Theater is a Discord Activity for watch parties from your own Plex
Media Server. One person hosts, playback stays in step for everyone in the
room, and each viewer picks their own audio track, subtitles and quality.

![A watch party running inside Discord](https://raw.githubusercontent.com/MonkeyGoneWIld/plex-discord-theater/main/docs/screenshots/player.jpg)

It runs as one Docker container beside your Plex server. It signs viewers in
with Discord, keeps each room in sync, and passes every Plex request and all
video through itself, so your Plex token never reaches a viewer's browser.

## Start here

New to the project? Follow these pages in order. Each one ends with a link to
the next.

| Step | Page | What you do |
|---|---|---|
| 1 | [Requirements](Requirements) | Check your server, network and upload speed |
| 2 | [Discord Application Setup](Discord-Application-Setup) | Create the Discord application and enable Activities |
| 3 | [Plex Setup](Plex-Setup) | Collect your Plex tokens and check a few Plex settings |
| 4 | [HTTPS and Reverse Proxy](HTTPS-and-Reverse-Proxy) | Give the server a public HTTPS address |
| 5 | [Installation](Installation) | Deploy the container and confirm it works |
| 6 | [First Launch](First-Launch) | Open the Activity in Discord and invite your viewers |

## For viewers and hosts

| Page | Covers |
|---|---|
| [Using the Activity](Using-the-Activity) | Browsing, the player, subtitles, settings and picture-in-picture |
| [Roles and Permissions](Roles-and-Permissions) | What hosts, co-hosts and viewers can do, and how the host role moves |
| [Personal Plex Sync](Personal-Plex-Sync) | Linking your own Plex account for watch history and Watchlist |
| [Requesting Titles](Requesting-Titles) | Asking for films and seasons that aren't in the library |

## For the server owner

| Page | Covers |
|---|---|
| [Streaming and Quality](Streaming-and-Quality) | When video is sent unchanged, when it is transcoded, and how to set bitrates |
| [FFmpeg Engine](FFmpeg-Engine) | Letting the container make the streams itself, on your GPU |
| [Dashboard](Dashboard) | Seeing what is playing, for whom and why, with history and statistics |
| [Configuration Reference](Configuration-Reference) | Every setting, with its default |
| [Optional Integrations](Optional-Integrations) | Plex Discover, TMDB, TVDB and Seerr |
| [qBittorrent Manager API](qBittorrent-Manager-API) | Lowering qBittorrent's upload while people watch |
| [Updating and Backups](Updating-and-Backups) | Updating, what is stored, backup and restore |

## Help

| Page | Covers |
|---|---|
| [Troubleshooting](Troubleshooting) | Problems, their causes and how to fix them |
| [FAQ](FAQ) | Short answers to common questions |
| [Local Development](Local-Development) | Running from source and working on the code |

> [!WARNING]
> This project was developed primarily with AI-assisted tooling and has not had
> an external security review. Run it on infrastructure you control, for people
> you know, and don't offer it as a public service.
