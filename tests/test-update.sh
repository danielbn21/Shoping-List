#!/usr/bin/env bash
# Tests update.sh against a real local git remote and a FAKE docker (no containers are started).
# Run from anywhere:  bash tests/test-update.sh
# shellcheck disable=SC2034  # variables are read inside the eval'd check strings
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL $1${2:+  [$2]}"; }
check() { if eval "$2"; then ok "$1"; else bad "$1" "${3:-}"; fi; }

# ---------- fake docker ----------
mkdir -p "$T/bin"
cat > "$T/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_LOG"
[[ "${1:-}" == compose ]] && shift
cmd="${1:-}"; shift || true
ver() { sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' server/package.json | head -1; }
mkdir -p .fake
case "$cmd" in
  version) exit 0 ;;
  build) [[ -n "${FAKE_BUILD_FAIL:-}" ]] && { echo "npm ERR! build failed" >&2; exit 1; }; ver > .fake/built ;;
  stop) rm -f .fake/running ;;
  up) [[ " $* " == *" --build "* ]] && ver > .fake/built
      cp .fake/built .fake/running
      if [[ -n "${FAKE_BAD_UP:-}" && "$(cat .fake/running)" != "${FAKE_GOOD_VERSION:-1.0.0}" ]]; then echo broken > .fake/running; fi ;;
  run) script=""; while [[ $# -gt 0 ]]; do [[ "$1" == "-c" ]] && { script="$2"; break; }; shift; done
       name="$(sed -n 's#.*/backups/\([^ ]*\.tar\.gz\).*#\1#p' <<<"$script" | head -1)"
       if [[ "$script" == *"tar czf"* ]]; then mkdir -p backups && tar czf "backups/$name" -C data . ; fi
       if [[ "$script" == *"tar xzf"* ]]; then tar xzf "backups/$name" -C data ; fi ;;
  exec) [[ -f .fake/running && "$(cat .fake/running)" != broken ]] && cat .fake/running || exit 1 ;;
  logs) echo "fake container log line" ;;
esac
exit 0
EOF
chmod +x "$T/bin/docker"
export PATH="$T/bin:$PATH" FAKE_LOG="$T/docker.log" HEALTH_TIMEOUT=2

# ---------- a remote and a server clone ----------
git init -q --bare -b main "$T/remote.git"
git clone -q "$T/remote.git" "$T/seed" 2>/dev/null
mkpkg() { mkdir -p "$T/seed/server"; printf '{\n  "name": "x",\n  "version": "%s"\n}\n' "$1" > "$T/seed/server/package.json"; }
release() { # release VERSION : commit + tag + push
  mkpkg "$1"; echo "$1" > "$T/seed/CHANGES"; ( cd "$T/seed" && git add -A && git commit -q -m "Release $1" && git tag "v$1" && git push -q origin main --tags )
}
( cd "$T/seed" && git config user.email t@t && git config user.name t && git checkout -q -b main 2>/dev/null
  echo "services: {}" > docker-compose.yml; printf 'data\nbackups\n.env\n.fake\n' > .gitignore
  cp "$HERE/update.sh" update.sh; chmod +x update.sh )
release 1.0.0
git clone -q "$T/remote.git" "$T/srv" 2>/dev/null
cd "$T/srv" || exit 1
git config user.email t@t; git config user.name t
mkdir data; echo original > data/db; mkdir .fake; echo 1.0.0 > .fake/built; echo 1.0.0 > .fake/running
U() { ./update.sh "$@" 2>&1; }
calls() { grep -c "$1" "$FAKE_LOG" 2>/dev/null || true; }

# 1. nothing new
out="$(U --yes)"; rc=$?
check "up to date: says so and changes nothing" "[[ \$rc -eq 0 && \"\$out\" == *'Already up to date'* && \$(calls ' stop') -eq 0 ]]" "$out"

# 2. a normal update
release 1.0.1
echo changed > data/db
: > "$FAKE_LOG"
out="$(U --yes)"; rc=$?
check "update succeeds and reports the new version" "[[ \$rc -eq 0 && \"\$out\" == *'Version 1.0.1 is running'* ]]" "$out"
check "code moved to 1.0.1" "grep -q 1.0.1 server/package.json"
check "backup of data taken before switching" "ls backups/shoplist-data-*-v1.0.0.tar.gz >/dev/null 2>&1 && tar xzOf backups/shoplist-data-*-v1.0.0.tar.gz ./db | grep -q changed"
check "build happens BEFORE stop (old version keeps serving during the build)" "[[ \$(grep -n ' build' \"\$FAKE_LOG\" | head -1 | cut -d: -f1) -lt \$(grep -n ' stop' \"\$FAKE_LOG\" | head -1 | cut -d: -f1) ]]"
check "rollback info recorded" "grep -q PREV_VERSION=1.0.0 backups/last-update.env"
check "git tree stays clean (data, backups, .env ignored)" "[[ -z \"\$(git status --porcelain)\" ]]" "$(git status --porcelain)"

# 3. manual rollback restores code and data
echo after-update > data/db
out="$(U --rollback --yes)"; rc=$?
check "rollback runs" "[[ \$rc -eq 0 && \"\$out\" == *'Back on version 1.0.0'* ]]" "$out"
check "rollback restored the old code" "grep -q '1.0.0' server/package.json"
check "rollback restored the backed-up data" "[[ \$(cat data/db) == changed ]]"
check "the data it replaced is kept aside" "ls -d data.failed-* >/dev/null 2>&1 && cat data.failed-*/db | grep -q after-update"

# 4. a failing build leaves everything as it was
release 1.0.2
before="$(git rev-parse HEAD)"; : > "$FAKE_LOG"
out="$(FAKE_BUILD_FAIL=1 U --yes)"; rc=$?
check "failed build: exits with an error and says the old version still runs" "[[ \$rc -ne 0 && \"\$out\" == *'old version is still running'* ]]" "$out"
check "failed build: the app was never stopped" "[[ \$(calls ' stop') -eq 0 ]]"
check "failed build: code is back on the previous commit" "[[ \$(git rev-parse HEAD) == \$before ]]"
check "failed build: still running 1.0.0" "[[ \$(cat .fake/running) == 1.0.0 ]]"

# 5. a new version that does not come up healthy is rolled back automatically
echo precious > data/db
out="$(FAKE_BAD_UP=1 FAKE_GOOD_VERSION=1.0.0 U --yes)"; rc=$?
check "unhealthy start: exits with an error and says it rolled back" "[[ \$rc -ne 0 && \"\$out\" == *'rolled back to 1.0.0'* ]]" "$out"
check "unhealthy start: previous version is running again" "[[ \$(cat .fake/running) == 1.0.0 ]]"
check "unhealthy start: data restored from the backup" "[[ \$(cat data/db) == precious ]]"
check "unhealthy start: the log is shown" "[[ \"\$out\" == *'fake container log line'* ]]"

# 6. local edits are refused
echo "x" >> docker-compose.yml
out="$(U --yes)"; rc=$?
check "local edits to tracked files block the update" "[[ \$rc -ne 0 && \"\$out\" == *'local edits'* ]]" "$out"
git checkout -q -- docker-compose.yml

# 7. move to a specific tag
out="$(U --yes --tag v1.0.1)"; rc=$?
check "--tag installs that exact release" "[[ \$rc -eq 0 && \$(cat .fake/running) == 1.0.1 && \"\$out\" == *'Version 1.0.1 is running'* ]]" "$out"
check "--tag works on a detached checkout and a later plain update still moves forward" "out2=\"\$(U --yes)\"; [[ \$? -eq 0 && \$(cat .fake/running) == 1.0.2 ]]"

# 8. dry run changes nothing
before="$(git rev-parse HEAD)"; release 1.0.3; : > "$FAKE_LOG"
out="$(U --dry-run)"; rc=$?
check "dry run: no changes made" "[[ \$rc -eq 0 && \$(git rev-parse HEAD) == \$before && \$(cat .fake/running) == 1.0.2 && \$(calls ' stop') -eq 0 && \$(calls ' up') -eq 0 ]]" "$out"
check "dry run: describes the steps" "[[ \"\$out\" == *'[dry-run]'* ]]"

# 9. syntax and style
check "bash -n finds no syntax errors" "bash -n '$HERE/update.sh'"
if command -v shellcheck >/dev/null 2>&1; then check "shellcheck is clean" "shellcheck -S warning '$HERE/update.sh'"; fi

echo; echo "passed: $PASS  failed: $FAIL"; [[ $FAIL -eq 0 ]]
