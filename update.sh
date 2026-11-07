#!/usr/bin/env bash
# update.sh - upgrade the Shopping List server from GitHub, safely.
#
# Run it on the server, in the project folder (the git clone that holds docker-compose.yml):
#   ./update.sh                  update to the newest commit of branch "main"
#   ./update.sh --tag v3.3.0     update to (or move back to) a specific release tag
#   ./update.sh --rollback       undo the last update (previous code + the data backup taken just before it)
#   ./update.sh --dry-run        show what would happen, change nothing
#
# What it does, in order:
#   1. checks (git clone, docker, no local edits), shows what will change and asks to confirm
#   2. checks out the new version and BUILDS it while the old one keeps running
#      (a failed build leaves the old version untouched and running)
#   3. stops the app and backs up data/ (database, receipt photos, secret.key) to backups/
#   4. starts the new version and waits until it reports the expected version
#   5. if it does not come up healthy, rolls back automatically (old code + restored data)
#
# Your data lives in ./data and your settings in ./.env. Both are untracked, so git never touches them.

set -Eeuo pipefail

SERVICE="${SERVICE:-shoplist}"          # service name in docker-compose.yml
BRANCH="${BRANCH:-main}"
BACKUP_KEEP="${BACKUP_KEEP:-10}"        # how many backups to keep
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-90}"  # seconds to wait for the new version to answer

TAG="" ; ROLLBACK=0 ; DRY=0 ; YES=0 ; FORCE=0 ; NO_BACKUP=0 ; NO_AUTO_ROLLBACK=0

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; echo; echo "Other options: --branch NAME  --yes  --force  --no-backup  --no-auto-rollback  --help"; }
die()  { echo "ERROR: $*" >&2; exit 1; }
info() { echo "==> $*"; }
warn() { echo "!!  $*" >&2; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --tag) TAG="${2:?--tag needs a value}"; shift 2 ;;
    --branch) BRANCH="${2:?--branch needs a value}"; shift 2 ;;
    --rollback) ROLLBACK=1; shift ;;
    --dry-run) DRY=1; shift ;;
    --yes|-y) YES=1; shift ;;
    --force) FORCE=1; shift ;;
    --no-backup) NO_BACKUP=1; shift ;;
    --no-auto-rollback) NO_AUTO_ROLLBACK=1; shift ;;
    --help|-h) usage; exit 0 ;;
    *) usage >&2; die "unknown option: $1" ;;
  esac
done

cd "$(dirname "${BASH_SOURCE[0]}")"
STATE="backups/last-update.env"

# ---------- helpers ----------
if docker compose version >/dev/null 2>&1; then DC=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then DC=(docker-compose)
else die "Docker Compose was not found. Install Docker with the compose plugin first."; fi

run() { if (( DRY )); then echo "[dry-run] $*"; else "$@"; fi; }

confirm() {
  (( YES || DRY )) && return 0
  read -r -p "$1 [y/N] " a; [[ "$a" == "y" || "$a" == "Y" ]]
}

tree_version() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' server/package.json 2>/dev/null | head -1; }

# Asks the running container (so no host curl and no port mapping are needed). Prints the version it reports.
health_version() {
  "${DC[@]}" exec -T "$SERVICE" node -e \
    "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>r.json()).then(j=>console.log(j.version||'unknown')).catch(()=>process.exit(1))" 2>/dev/null
}

# wait_healthy WANT  (WANT=any accepts any answer, used when going back to a version that predates version reporting)
wait_healthy() {
  local want="$1" waited=0 v=""
  while (( waited < HEALTH_TIMEOUT )); do
    v="$(health_version || true)"
    if [[ -n "$v" ]]; then
      [[ "$want" == "any" || "$v" == "$want" ]] && { echo "$v"; return 0; }
    fi
    sleep 3; waited=$(( waited + 3 ))
  done
  echo "${v:-no answer}"; return 1
}

# The backup runs inside a throwaway container from the app image, as root, because some files in data/ (secret.key) are
# readable only by the container's user, not by you.
backup_data() {
  local version="$1" name
  name="shoplist-data-$(date +%Y%m%d-%H%M%S)-v${version}.tar.gz"
  mkdir -p backups
  "${DC[@]}" run --rm --no-deps -T -v "$PWD/backups:/backups" -e HOST_UID="$(id -u)" -e HOST_GID="$(id -g)" \
    --entrypoint sh "$SERVICE" -c "tar czf /backups/$name -C /data . && chown \$HOST_UID:\$HOST_GID /backups/$name" >&2
  echo "backups/$name"
}

restore_data() {
  local file="$1"
  [[ -f "$file" ]] || die "backup file not found: $file"
  if [[ -d data ]]; then mv data "data.failed-$(date +%Y%m%d-%H%M%S)"; fi   # keep what was there, just in case
  mkdir -p data
  "${DC[@]}" run --rm --no-deps -T -v "$PWD/backups:/backups:ro" --entrypoint sh "$SERVICE" -c "tar xzf /backups/$(basename "$file") -C /data" >&2
}

prune_backups() {
  # shellcheck disable=SC2012
  ls -1t backups/shoplist-data-*.tar.gz 2>/dev/null | tail -n +"$(( BACKUP_KEEP + 1 ))" | while read -r old; do rm -f "$old"; done
}

save_state() { printf 'PREV_COMMIT=%s\nPREV_VERSION=%s\nBACKUP=%s\nTARGET_COMMIT=%s\nWHEN=%s\n' "$1" "$2" "$3" "$4" "$(date -Is)" > "$STATE"; }

do_rollback() {
  local prev_commit="$1" backup="$2"
  warn "Rolling back to ${prev_commit:0:9}${backup:+ with data from $backup}"
  "${DC[@]}" stop || true
  git checkout -q -f --detach "$prev_commit"
  if [[ -n "$backup" && -f "$backup" ]]; then restore_data "$backup"; fi
  "${DC[@]}" up -d --build
  local v; v="$(wait_healthy any || true)"
  info "Back on version ${v} (code ${prev_commit:0:9})."
}

# ---------- sanity checks ----------
git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "This is not a git clone. Clone the repository first (see docs/HANDOFF.md)."
[[ -f docker-compose.yml ]] || die "docker-compose.yml not found: run this from the project folder."
[[ -f .env ]] || warn "No .env file. The default port 3000 will be used. To keep a custom port across upgrades: echo HOST_PORT=3010 > .env"

# ---------- manual rollback ----------
if (( ROLLBACK )); then
  [[ -f "$STATE" ]] || die "Nothing to roll back: $STATE does not exist."
  # shellcheck disable=SC1090
  source "$STATE"
  info "Last update: ${PREV_VERSION} -> $(tree_version) on ${WHEN}"
  info "Rollback restores code ${PREV_COMMIT:0:9} and the backup ${BACKUP:-<none>}. Changes made since that update will be lost."
  confirm "Roll back now?" || die "cancelled"
  run do_rollback "$PREV_COMMIT" "${BACKUP:-}"
  exit 0
fi

PREV_COMMIT="$(git rev-parse HEAD)"
PREV_VERSION="$(tree_version)"
if (( ! FORCE )) && ! { git diff --quiet && git diff --cached --quiet; }; then
  die "You have local edits to tracked files. Commit or discard them (or use --force). git status shows which."
fi

info "Fetching from GitHub"
git fetch --tags --prune origin
if [[ -n "$TAG" ]]; then REF="refs/tags/$TAG"; else REF="origin/$BRANCH"; fi
TARGET_COMMIT="$(git rev-parse --verify --quiet "${REF}^{commit}")" || die "Could not find ${TAG:-branch $BRANCH} on origin."

if [[ "$TARGET_COMMIT" == "$PREV_COMMIT" ]]; then
  info "Already up to date: version ${PREV_VERSION} (${PREV_COMMIT:0:9})."
  RUNNING="$(health_version || true)"
  if [[ -n "$RUNNING" ]]; then info "The running container reports version ${RUNNING}."
  else warn "The container is not answering. Start it with: ${DC[*]} up -d --build"; fi
  exit 0
fi

info "Updating ${PREV_VERSION} (${PREV_COMMIT:0:9}) -> ${TAG:-$BRANCH} (${TARGET_COMMIT:0:9})"
git --no-pager log --oneline --no-decorate -n 15 "${PREV_COMMIT}..${TARGET_COMMIT}" 2>/dev/null || true
confirm "Continue?" || die "cancelled"

# ---------- 1. check out and build, while the old version keeps running ----------
if [[ -n "$TAG" ]]; then run git checkout -q --detach "$TARGET_COMMIT"
else run git checkout -q "$BRANCH"; run git merge -q --ff-only "origin/$BRANCH"; fi
NEW_VERSION="$(tree_version)"; (( DRY )) && NEW_VERSION="(new)"
info "Building version ${NEW_VERSION} (the current version keeps serving meanwhile)"
if ! run "${DC[@]}" build; then
  warn "The build FAILED. Putting the code back; the old version is still running and unchanged."
  git checkout -q -f --detach "$PREV_COMMIT"
  exit 1
fi

# ---------- 2. back up data, then switch over ----------
BACKUP=""
info "Stopping the app for a consistent backup"
run "${DC[@]}" stop
if (( NO_BACKUP )); then warn "Skipping the backup (--no-backup)."
elif [[ -d data ]]; then
  if (( DRY )); then echo "[dry-run] backup data/ to backups/"; else BACKUP="$(backup_data "$PREV_VERSION")"; info "Backup saved: $BACKUP"; fi
else warn "No data/ folder yet, nothing to back up."; fi
(( DRY )) || save_state "$PREV_COMMIT" "$PREV_VERSION" "$BACKUP" "$TARGET_COMMIT"

info "Starting the new version"
run "${DC[@]}" up -d
if (( DRY )); then info "Dry run finished. Nothing was changed."; exit 0; fi

# ---------- 3. verify, roll back if it does not come up ----------
if GOT="$(wait_healthy "$NEW_VERSION")"; then
  prune_backups
  info "Done. Version ${GOT} is running (was ${PREV_VERSION})."
  [[ -n "$BACKUP" ]] && info "Data backup: $BACKUP"
  info "If something is wrong: ./update.sh --rollback"
  info "Devices that still show the old screens will offer an 'Update now' banner."
  exit 0
fi

warn "The new version did not become healthy (it reported: ${GOT}). Recent log:"
"${DC[@]}" logs --tail 40 "$SERVICE" 2>&1 | sed 's/^/    /' >&2 || true
if (( NO_AUTO_ROLLBACK )); then die "Left as is (--no-auto-rollback). Roll back with ./update.sh --rollback"; fi
do_rollback "$PREV_COMMIT" "$BACKUP"
die "Update failed and was rolled back to ${PREV_VERSION}. See the log above."
