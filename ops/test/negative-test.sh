#!/bin/sh
# negative-test.sh — prove restore-drill.sh actually FAILS on a bad snapshot.
#
# A verification tool that only ever reports success is worthless. Every green
# drill result is only meaningful if we know the drill is capable of going red.
# This builds a DELIBERATELY WRONG snapshot in a scratch directory — a real
# snapshot with one user object altered — and asserts the drill notices and
# exits non-zero.
#
# This exists because the drill shipped with a bug that did exactly the wrong
# thing: the volume comparison ran `sh -s` in `docker run` without `-i`, so the
# inner script never executed, docker exited 0, and the drill reported a PASS
# having checked nothing at all. A green light that verifies nothing is worse
# than no light. This test is the guard against that returning.
#
# PRODUCTION IS NEVER INVOLVED. Everything happens in a scratch directory; the
# drill itself only ever reads the live volumes.
#
# USAGE
#   ./negative-test.sh            # use the most recent snapshot as the source
#   ./negative-test.sh <stamp>
#
# EXIT CODES
#   0 the drill correctly rejected a bad snapshot (this test PASSED)
#   1 the drill accepted a snapshot it should have rejected (investigate!)

set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
DRILL="$HERE/../restore-drill.sh"
SRC="${BUZZ_BACKUP_DIR:-$HOME/.agnt/buzz-backup/backups}"
SCRATCH="${TMPDIR:-/tmp}/buzz-negative-test.$$"

[ -x "$DRILL" ] || { echo "restore-drill.sh not found or not executable at $DRILL" >&2; exit 1; }

STAMP="${1:-$(find "$SRC" -maxdepth 1 -name 'buzz-pg-*.dump' 2>/dev/null \
  | sed 's|.*/buzz-pg-||; s|\.dump$||' | sort | tail -1)}"
[ -n "$STAMP" ] || { echo "no snapshots found in $SRC" >&2; exit 1; }

MINIO_TAR="buzz-minio-$STAMP.tar.gz"
[ -f "$SRC/$MINIO_TAR" ] || { echo "snapshot $STAMP has no minio archive to corrupt" >&2; exit 1; }

cleanup() {
  # Only ever removes files this test created, inside its own scratch dir.
  [ -d "$SCRATCH" ] || return 0
  find "$SCRATCH" -type f -delete
  find "$SCRATCH" -depth -type d -exec rmdir {} + 2>/dev/null || true
}
trap cleanup EXIT INT TERM

WORK="$SCRATCH/extract"
mkdir -p "$WORK"

echo "== building a deliberately-wrong copy of snapshot $STAMP"

# Copy the parts the drill needs, unaltered.
for f in "buzz-pg-$STAMP.dump" "buzz-git-$STAMP.tar.gz" "buzz-manifest-$STAMP.txt"; do
  [ -f "$SRC/$f" ] && cp "$SRC/$f" "$SCRATCH/"
done

# Rebuild the minio archive with exactly one USER object altered. User objects
# are the drill's pass/fail criterion; .minio.sys churn is deliberately ignored
# by the drill, so corrupting that would prove nothing.
#
# --no-mac-metadata keeps macOS from adding AppleDouble (._*) sidecar files,
# which would ALSO trip the drill — but for the wrong reason, muddying the test.
tar xzf "$SRC/$MINIO_TAR" -C "$WORK"
VICTIM=$(find "$WORK" -type f ! -path '*.minio.sys*' | head -1)
[ -n "$VICTIM" ] || { echo "no user objects in the minio archive to alter" >&2; exit 1; }
echo "   altering: ${VICTIM#$WORK/}"
printf 'altered-by-negative-test' >> "$VICTIM"
(cd "$WORK" && tar czf "$SCRATCH/$MINIO_TAR" --no-mac-metadata . 2>/dev/null \
  || tar czf "$SCRATCH/$MINIO_TAR" .)

echo
echo "== running the drill against it (expecting FAILURE)"
set +e
BUZZ_BACKUP_DIR="$SCRATCH" "$DRILL" "$STAMP" > "$SCRATCH/drill.out" 2>&1
RC=$?
set -e

sed -n '/VOLUME PAYLOADS/,$p' "$SCRATCH/drill.out" | sed 's/^/   /'

echo
if [ "$RC" -ne 0 ]; then
  echo "== TEST PASSED — the drill rejected a bad snapshot (exit $RC)"
  exit 0
fi
echo "== TEST FAILED — the drill reported success on a snapshot it should have rejected."
echo "   The drill cannot be trusted until this is understood. Full output:"
sed 's/^/   /' "$SCRATCH/drill.out"
exit 1
