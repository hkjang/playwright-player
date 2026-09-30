#!/bin/sh
# The container's default user is pwuser (uid 1001), but a bind-mounted data
# directory is owned by whoever created it on the host — usually uid 1000. That
# mismatch made `docker compose up` fail at boot with EACCES on /app/data.
#
# When started as root this aligns ownership of the directories the server owns
# and then drops to pwuser, so the server itself never runs as root. When started
# with an explicit --user it cannot chown, so it just execs and lets the server
# report a clear error if a directory really is unwritable.
#
# SCRIPTS_DIR is deliberately left alone: it is usually the operator's own
# checked-out source, and rewriting its ownership on every boot is worse than an
# explicit permission error on upload.
set -e

APP_USER=pwuser
APP_UID="$(id -u "$APP_USER")"
OWNED_DIRS="${DATA_DIR:-/app/data} ${STORAGE_STATE_DIR:-/app/storage-states}"

if [ "$(id -u)" = "0" ]; then
  for dir in $OWNED_DIRS; do
    [ -d "$dir" ] || mkdir -p "$dir"
    # A large mounted history should not be re-chowned on every boot, so only act
    # when the top-level ownership is actually wrong.
    if [ "$(stat -c %u "$dir")" != "$APP_UID" ]; then
      chown -R "$APP_USER:$APP_USER" "$dir" \
        || echo "warning: could not chown $dir; the server may not be able to write to it" >&2
    fi
  done

  scripts_dir="${SCRIPTS_DIR:-/app/scripts}"
  if [ -d "$scripts_dir" ] && ! su "$APP_USER" -s /bin/sh -c "test -w '$scripts_dir'"; then
    echo "note: $scripts_dir is not writable by $APP_USER (uid $APP_UID); reading scripts works, uploading them will not." >&2
  fi

  exec setpriv --reuid="$APP_USER" --regid="$APP_USER" --init-groups "$@"
fi

exec "$@"
