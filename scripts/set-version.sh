#!/usr/bin/env bash
# Sets the app version everywhere it lives (server and web package.json plus their lockfiles) in one go.
#   scripts/set-version.sh 1.0.1
# Then:  git commit -am "Release v1.0.1" && git tag -a v1.0.1 -m "v1.0.1" && git push && git push --tags
set -euo pipefail
v="${1:?usage: scripts/set-version.sh X.Y.Z}"
[[ "$v" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || { echo "Not a valid version: $v (use X.Y.Z)" >&2; exit 1; }
cd "$(dirname "${BASH_SOURCE[0]}")/.."
for d in server web; do
  ( cd "$d" && npm version "$v" --no-git-tag-version --allow-same-version >/dev/null )
done
echo "server: $(node -p "require('./server/package.json').version")   web: $(node -p "require('./web/package.json').version")"
