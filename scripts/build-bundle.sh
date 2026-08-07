#!/bin/sh
# build-bundle.sh -- produce dist/buzz-cli-plugin.agnt (the installable plugin).
#
# WHY THIS EXISTS
#   There was no build script, so the bundle was produced by hand and quietly
#   went stale: the v1.4.9 tree shipped a dist/ built before ops/ existed, and
#   nothing detected the drift. This makes the bundle a function of the repo.
#
# WHAT GOES IN
#   Exactly the git-tracked files -- so .gitignore is the single source of truth
#   for what is excluded (node_modules/, dist/, *.nsec, *.token, *.key, .env,
#   config.json, listener-state.json ...). Secrets cannot be swept in by accident
#   because they are already ignored, and an untracked scratch file cannot end up
#   in a release.
#
# Usage:  ./scripts/build-bundle.sh
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd)
NAME=buzz-cli-plugin
OUT="$ROOT/dist/$NAME.agnt"

command -v git >/dev/null 2>&1 || { echo "error: git not found" >&2; exit 1; }

# --- version consistency -----------------------------------------------------
MV=$(node -pe "require('./manifest.json').version")
PV=$(node -pe "require('./package.json').version")
if [ "$MV" != "$PV" ]; then
  echo "error: version mismatch -- manifest.json=$MV package.json=$PV" >&2
  exit 1
fi
echo "version: $MV"

# --- warn (do not fail) on a dirty tree --------------------------------------
# Building from the working tree is intentional: it lets you verify a bundle
# before committing. But an unexpectedly dirty tree is worth saying out loud.
if [ -n "$(git status --porcelain)" ]; then
  echo "note: working tree has uncommitted changes; bundling working-tree content"
fi

# --- stage ------------------------------------------------------------------
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT INT TERM
mkdir -p "$STAGE/$NAME"

COUNT=0
git ls-files -z | while IFS= read -r -d '' f; do
  mkdir -p "$STAGE/$NAME/$(dirname "$f")"
  cp -p "$f" "$STAGE/$NAME/$f"
done
COUNT=$(git ls-files | wc -l | tr -d ' ')

# --- pack -------------------------------------------------------------------
# --no-mac-metadata: macOS bsdtar otherwise adds AppleDouble ._* sidecar files,
# which pollute the bundle and confuse consumers that enumerate its entries.
mkdir -p "$ROOT/dist"
TAR_FLAGS=""
if tar --no-mac-metadata --version >/dev/null 2>&1; then
  TAR_FLAGS="--no-mac-metadata"
fi
# shellcheck disable=SC2086
( cd "$STAGE" && tar $TAR_FLAGS -czf "$OUT" "$NAME" )

# --- verify -----------------------------------------------------------------
ENTRIES=$(tar -tzf "$OUT" | grep -vc '/$' || true)
if tar -tzf "$OUT" | grep -q '/\._'; then
  echo "error: bundle contains AppleDouble ._* files" >&2
  exit 1
fi
if [ "$ENTRIES" -ne "$COUNT" ]; then
  echo "error: bundled $ENTRIES files but $COUNT are tracked" >&2
  exit 1
fi
# The manifest must be readable by the installer, and must be the version we
# just claimed -- a bundle whose manifest disagrees with the tag is a bad build.
BV=$(tar -xzOf "$OUT" "$NAME/manifest.json" | node -pe "JSON.parse(require('fs').readFileSync(0,'utf8')).version")
[ "$BV" = "$MV" ] || { echo "error: bundled manifest says $BV, expected $MV" >&2; exit 1; }

echo "built:   $OUT"
echo "files:   $ENTRIES"
echo "size:    $(wc -c < "$OUT" | tr -d ' ') bytes"
echo "manifest version verified: $BV"
