#!/bin/sh
# Runs as root once per container start, then hands over to the app user.
set -eu

# Give the app user what it writes, under `dir`: only what isn't already its
# own, and never anything mounted inside it. A media library mounted at
# /data/media, read-only, would otherwise be walked file by file on every
# start, and refuse each one. Mounts are left out by name as well as by
# filesystem (-xdev), since a bind mount from the same disk shares one.
own() {
  dir=$1
  set --
  while read -r _ _ _ _ point _; do
    case "$point" in
      "$dir"/*) set -- "$@" -path "$point" -prune -o ;;
    esac
  done < /proc/self/mountinfo
  find "$dir" -xdev "$@" \( ! -user appuser -o ! -group appgroup \) -exec chown -h appuser:appgroup {} + 2>/dev/null || true
}

own /data
# The stream cache, when STREAM_CACHE_DIR is a mount of its own.
if [ -n "${STREAM_CACHE_DIR:-}" ]; then
  mkdir -p "$STREAM_CACHE_DIR"
  own "$STREAM_CACHE_DIR"
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
