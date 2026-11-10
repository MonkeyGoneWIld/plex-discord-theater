# VPS Relay

The relay is optional. With it, your home server uploads each stream once to a
VPS, and the VPS serves everyone watching.

This page explains when you need it and how to connect it. The step-by-step
VPS setup (provisioning, DNS, certificates, the complete nginx configuration
and Cloudflare rules) is in
[`docs/vps-relay-setup.md`](https://github.com/MonkeyGoneWIld/plex-discord-theater/blob/main/docs/vps-relay-setup.md)
in the repository.

## How it works

Without the relay, every viewer downloads the stream from your home server,
so your upload grows with the room. Viewers on the same stream share some
segments peer to peer, but that depends on their connections. Since v2.2.0,
Discord's own proxy also keeps a copy of each segment for a short time, so
viewers who reach Discord through the same data center often get it from
there and not from your server. With two viewers, about half the segments
came from Discord's copy in testing. Viewers in other regions still each
download from your server.

| Viewers | Upload at 20 Mbps each |
|---|---|
| 1 | 20 Mbps |
| 5 | 100 Mbps |
| 10 | 200 Mbps |

With the relay, the VPS fetches each segment from your server once, caches it,
and serves it to every viewer:

```text
Without the relay:
  Plex ──► Activity server ──► Viewer 1
                           ──► Viewer 2
                           ──► Viewer 3
  Home upload: viewers × bitrate

With the relay:
  Plex ──► Activity server ──► VPS (nginx cache) ──► Viewer 1
                                                 ──► Viewer 2
                                                 ──► Viewer 3
  Home upload: one copy of each stream
```

Playlists still come from your server directly; they are a few kilobytes each.
While the relay is on, peer-to-peer sharing is turned off, because the relay
replaces it.

## Do you need it?

| Situation | Recommendation |
|---|---|
| One or two viewers | No |
| Three or four viewers with a fast upload | Usually not. Lower the [bitrate limits](Streaming-and-Quality#choosing-the-bitrate-limits) first. |
| Five or more viewers | Yes |
| A slow upload, at any room size | Yes, or lower the quality |
| Other people use your Plex during watch parties | Yes |

Lowering `VIDEO_BITRATE_KBPS` and `DIRECT_STREAM_MAX_KBPS` is the simpler
first step: halving them halves your upload.

## What you need

- A VPS with a fast network connection. It caches and serves files and does
  no encoding, so a small one with a 1 Gbps port is enough.
- A subdomain pointing at it, for example `relay.example.com`.
- nginx on the VPS, with a certificate from Let's Encrypt.

## Connect it

### 1. Set up the VPS

Follow
[`docs/vps-relay-setup.md`](https://github.com/MonkeyGoneWIld/plex-discord-theater/blob/main/docs/vps-relay-setup.md).

### 2. Create the shared key

```bash
openssl rand -hex 32
```

The same key goes in the VPS's nginx configuration and in the server's
settings. It proves to your server that segment requests come from the relay.

### 3. Configure the server

```yaml
      VPS_RELAY_URL: "https://relay.example.com"
      VPS_RELAY_KEY: "the-key-from-step-2"
```

The relay is used only when both settings are set. Recreate the container
with `docker compose up -d`.

### 4. Add the Discord URL mapping

In the Discord Developer Portal, under **Activities → URL Mappings**, add:

| Prefix | Target |
|---|---|
| `/theater` | `relay.example.com` |

Without it, Discord's proxy blocks the segments the relay serves, and playback
fails without a clear error.

## Check it

- The startup summary shows `✓ VPS relay`.
- In the player, **Stats for nerds** (**I**) shows the segment source as
  **VPS relay (HTTP)**.
- On the VPS, nginx's access log shows segment requests, with cache hits after
  the first viewer.

## Troubleshooting

| Symptom | Cause |
|---|---|
| Segments return 403 | The key differs between the VPS and the server, or Cloudflare blocks the VPS's address |
| Segments return 502 | The VPS can't reach your server: check DNS, the firewall and the proxy |
| Playback stutters | nginx on the VPS proxies to Plex directly instead of to the Activity server |
| Segments are blocked inside Discord | The `/theater` URL mapping is missing |

## Next

→ [qBittorrent Manager API](qBittorrent-Manager-API)
