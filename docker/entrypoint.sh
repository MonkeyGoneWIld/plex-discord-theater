#!/bin/sh
# Runs as root once per container start, then hands over to the app user.
set -eu

# What the app writes is its own: only what isn't already, and never across
# into another filesystem. A media library mounted under /data (read-only)
# would otherwise be walked file by file on every start, and refuse each one.
find /data -xdev \( ! -user appuser -o ! -group appgroup \) -exec chown -h appuser:appgroup {} + 2>/dev/null || true

# The stream cache, when STREAM_CACHE_DIR is a mount of its own.
if [ -n "${STREAM_CACHE_DIR:-}" ]; then
  mkdir -p "$STREAM_CACHE_DIR"
  find "$STREAM_CACHE_DIR" -xdev \( ! -user appuser -o ! -group appgroup \) -exec chown -h appuser:appgroup {} + 2>/dev/null || true
fi

# A GPU mapped in (/dev/dri) belongs to whichever group owns it here, and that
# number differs from host to host, and again inside an LXC. The app runs in
# that group too, so ffmpeg can open it without a group_add in compose.
groups="$(id -g appuser)"
for node in /dev/dri/renderD* /dev/dri/card*; do
  [ -e "$node" ] || continue
  gid="$(stat -c %g "$node")"
  case ",$groups," in
    *",$gid,"*) ;;
    *) groups="$groups,$gid" ;;
  esac
done

export HOME=/data
exec setpriv --reuid=appuser --regid=appgroup --groups="$groups" --inh-caps=-all -- "$@"
