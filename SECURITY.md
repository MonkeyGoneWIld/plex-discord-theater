# Security notes

## Dependency advisories

Transitive packages are pinned to patched releases through `overrides` in the
root `package.json` — see the comment block beside it for what each pin is for.
Those pins exist because the direct dependency (Express, `socks` via
`bittorrent-tracker`) hasn't picked the fix up yet; drop a pin once its parent
ships the same version or newer.

The production image deletes npm after `npm ci` (see the Dockerfile). npm
vendors its own copies of `tar`, `undici` and `brace-expansion`, which a scanner
sees as part of the image even though nothing in the running container can
reach them — the container starts `node` directly and never shells out. The base
image also gets `apk upgrade` so Alpine patches published since the image was
cut are applied.

### Known, unfixed: `ip` (GHSA-2p57-rm9w-gvfp / CVE-2024-29415)

`ip@2.0.1` misclassifies some address forms (`127.1`, `::ffff:127.0.0.1`, …) as
publicly routable in `isPublic`. There is no fixed release — 2.0.1 is the latest
published version, and `bittorrent-tracker@11.2.3` still depends on it. It
cannot be pinned away.

It stays because the exposure here is narrow:

- The advisory matters when an application decides whether to *fetch* an address
  based on `isPublic`. This server never fetches peer addresses. The embedded
  tracker only relays WebRTC signaling between browsers.
- The tracker is constructed with every built-in transport off
  (`http: false, udp: false, ws: false`) and is handed sockets that the app has
  already upgraded and authenticated with a session token, so it isn't
  reachable by an unauthenticated caller.
- P2P is the fallback path. With `VPS_RELAY_URL` configured, segments go through
  the relay and the peer mesh isn't used at all.

Worth re-checking whenever `bittorrent-tracker` releases: the fix has to come
from it dropping `ip` or `ip` shipping a patch.

## Reporting

Found something? Open a private security advisory on the GitHub repository
rather than a public issue.
