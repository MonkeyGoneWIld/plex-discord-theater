# HTTPS and Reverse Proxy

Discord loads an Activity only from a public HTTPS address. On this page you
give the server that address. Choose one option:

| Option | Best for |
|---|---|
| [Cloudflare Tunnel](#cloudflare-tunnel) | Most home servers: no open ports, no static IP, and a free certificate |
| [Reverse proxy](#reverse-proxy) | You already run nginx, Caddy or Traefik with a certificate |

Whichever you choose, the address must:

- **Stay the same.** It is entered in the Discord Developer Portal and in
  `REDIRECT_URI` and `ALLOWED_ORIGINS`. If it changes, update all three.
- **Forward to the container's port**, 3000 by default.
- **Pass WebSocket connections.** Room sync (`/ws`) and the peer-to-peer
  tracker (`/tracker`) use WebSockets. Without them, everyone sees
  "Reconnecting".
- **Not buffer responses.** Video segments stream through the server, and
  buffering delays them.

## Cloudflare Tunnel

A tunnel connects outward from your network to Cloudflare, so you don't open
any ports on your router. Tunnels pass WebSockets without extra settings.

### Named tunnel

A named tunnel keeps the same host name. It needs a domain on Cloudflare.

1. In the Cloudflare dashboard, open **Zero Trust → Networks → Tunnels** and
   create a tunnel.
2. Install the connector (`cloudflared`) on a machine that can reach the
   container, as the dashboard shows.
3. Add a public hostname, for example `watch.example.com`, with the service
   `http://<container-host>:3000`.

Cloudflare's guide:
[Create a tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/get-started/create-remote-tunnel/).

### Quick tunnel, for testing

```bash
cloudflared tunnel --url http://localhost:3000
```

This prints a temporary `https://….trycloudflare.com` address. The address
changes every time `cloudflared` restarts, so use it only to try the Activity
out.

## Reverse proxy

Proxy your host name to `http://<container-host>:3000`.

### nginx

```nginx
server {
    listen 443 ssl;
    server_name watch.example.com;
    # ssl_certificate and ssl_certificate_key as for your other sites

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
}
```

### Caddy

Caddy passes WebSockets and streams responses by default, and obtains the
certificate itself:

```caddyfile
watch.example.com {
    reverse_proxy 127.0.0.1:3000
}
```

### Traefik

Route the host name to the container's port 3000. Traefik passes WebSockets by
default.

## One proxy in front

The server trusts exactly one proxy in front of it to report each viewer's
address, which it uses for rate limits and logs. A tunnel or a reverse proxy
counts as one. Don't chain a second proxy in front of the first, and don't
also expose port 3000 directly to the internet.

## Check the address

After [Installation](Installation), open `https://watch.example.com/api/health`
in a browser. This reply means the address reaches the server and the server
reaches Plex:

```json
{"status":"ok","plex":"reachable","uptimeS":42}
```

## Next

→ [Installation](Installation)
