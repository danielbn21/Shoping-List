#!/bin/sh
# Make the data folder writable no matter who owns it on the host (bind mounts are often root-owned),
# then drop privileges and start the app as the unprivileged "node" user.
set -e
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/data}"
  chown -R node:node "${DATA_DIR:-/data}" 2>/dev/null || echo "warning: could not chown ${DATA_DIR:-/data}; if startup fails, run: chown -R 1000:1000 <host data folder>"
  exec setpriv --reuid=node --regid=node --init-groups -- "$@"
fi
exec "$@"
