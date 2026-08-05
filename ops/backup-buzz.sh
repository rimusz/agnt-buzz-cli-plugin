#!/bin/sh
# backup-buzz.sh — nightly backup of a self-hosted Buzz relay stack.
#
# WHAT IT PROTECTS
#   Everything a Buzz relay remembers lives in Docker volumes: channels,
#   messages, DMs and the audit log in Postgres; attachments in MinIO; the
#   relay's git store. Volumes are trivially destroyed — `docker compose down -v`,
#   a bad migration, a Docker Desktop "reset" — and there is no undo.
#
#   This produces a restorable snapshot of all three, verifies the Postgres dump
#   is actually readable, and prunes anything older than the retention window.
#
# WHAT IT DOES NOT PROTECT AGAINST
#   By default the copy lands on the SAME DISK as the volumes, so it is not a
#   defence against drive failure. Point BUZZ_BACKUP_DIR at external or synced
#   storage for that.
#
# USAGE
#   ./backup-buzz.sh              # run a backup
#   ./backup-buzz.sh --verify     # also test-restore into a scratch database
#   ./backup-buzz.sh --drill      # also run the FULL restore drill on what was
#                                 # just written (see restore-drill.sh)
#
# --verify vs --drill
#   --verify checks only the Postgres dump, in the same run that produced it.
#   --drill re-reads the archives FROM DISK and checks all three payloads,
#   md5-comparing restored MinIO objects and git files against the live volumes.
#   --drill is the stronger claim, so it supersedes --verify when both are given.
#
#   Chaining --drill onto the nightly job means every snapshot is proven
#   recoverable the moment it is taken, rather than the first time it is needed.
#
# CONFIG (all optional, sensible defaults for a standard `buzz-prod` stack)
#   BUZZ_BACKUP_DIR         where dumps are written   (~/.agnt/buzz-backup/backups)
#   BUZZ_BACKUP_KEEP_DAYS   retention window          (14)
#   BUZZ_PG_CONTAINER       postgres container name   (buzz-prod-postgres-1)
#   BUZZ_MINIO_VOLUME       minio volume name         (buzz-prod_buzz-minio-data)
#   BUZZ_GIT_VOLUME         git-store volume name     (buzz-prod_buzz-git-data)
#   BUZZ_TAR_IMAGE          image used to tar volumes (postgres:17-alpine)
#
# EXIT CODES
#   0 ok
#   1 backup failed
#   2 backup written but the drill REJECTED it (snapshot kept for inspection)
#   69 docker or container unavailable

set -eu

CONTAINER="${BUZZ_PG_CONTAINER:-buzz-prod-postgres-1}"
MINIO_VOL="${BUZZ_MINIO_VOLUME:-buzz-prod_buzz-minio-data}"
GIT_VOL="${BUZZ_GIT_VOLUME:-buzz-prod_buzz-git-data}"
DEST="${BUZZ_BACKUP_DIR:-$HOME/.agnt/buzz-backup/backups}"
KEEP_DAYS="${BUZZ_BACKUP_KEEP_DAYS:-14}"
# Reuse an image the stack already has, so a backup never depends on a pull.
TAR_IMAGE="${BUZZ_TAR_IMAGE:-postgres:17-alpine}"

STAMP=$(date -u '+%Y%m%d-%H%M%S')
LOG="${DEST%/backups}/backup.log"
VERIFY=0
DRILL=0
for arg in "$@"; do
  case "$arg" in
    --verify) VERIFY=1 ;;
    --drill)  DRILL=1 ;;
    -h|--help)
      sed -n '2,40p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *)
      echo "unknown option: $arg (try --help)" >&2
      exit 64 ;;
  esac
done
# The drill restores into a scratch database as part of its own work, so running
# --verify as well would do the same job twice, more weakly.
[ "$DRILL" -eq 1 ] && VERIFY=0

# restore-drill.sh ships alongside this script, in both the repo (ops/) and the
# deployed copy, so a sibling lookup works in either location.
DRILL_BIN="${BUZZ_DRILL_BIN:-$(cd "$(dirname "$0")" && pwd)/restore-drill.sh}"

mkdir -p "$DEST" "$(dirname "$LOG")"

log() {
  printf '[%s] %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$1" | tee -a "$LOG"
}

fail() {
  log "FAILED: $1"
  exit "${2:-1}"
}

# --- preflight --------------------------------------------------------------
command -v docker >/dev/null 2>&1 || fail "docker not on PATH" 69
docker info >/dev/null 2>&1 || fail "docker daemon not reachable" 69
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" \
  || fail "container '$CONTAINER' is not running" 69

PGUSER=$(docker exec "$CONTAINER" printenv POSTGRES_USER 2>/dev/null || echo postgres)
PGDB=$(docker exec "$CONTAINER" printenv POSTGRES_DB 2>/dev/null || echo postgres)

log "=== backup $STAMP → $DEST"
log "postgres: container=$CONTAINER db=$PGDB user=$PGUSER"

# --- 1. postgres ------------------------------------------------------------
# Custom format (-Fc): compressed, and restorable selectively with pg_restore.
# pg_dump takes an MVCC snapshot, so the relay can keep serving throughout.
DUMP="$DEST/buzz-pg-$STAMP.dump"
docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" -Fc --no-owner --no-acl \
  > "$DUMP" 2>>"$LOG" || fail "pg_dump failed"

[ -s "$DUMP" ] || fail "pg_dump produced an empty file"

# A dump you cannot read is not a backup. pg_restore --list parses the archive
# header and table of contents; if that succeeds the file is structurally sound.
TOC_LINES=$(docker exec -i "$CONTAINER" pg_restore --list < "$DUMP" 2>>"$LOG" | grep -c ';' || true)
[ "$TOC_LINES" -gt 0 ] || fail "dump is unreadable (pg_restore --list found no entries)"

log "postgres: $(du -h "$DUMP" | awk '{print $1}')  ($TOC_LINES archive entries, readable)"

# --- 2. minio (attachments) + git store -------------------------------------
backup_volume() {
  vol="$1"; label="$2"
  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    log "$label: volume '$vol' not found — skipped"
    return 0
  fi
  out="$DEST/buzz-$label-$STAMP.tar.gz"
  docker run --rm \
    -v "$vol":/src:ro \
    -v "$DEST":/backup \
    "$TAR_IMAGE" \
    tar czf "/backup/$(basename "$out")" -C /src . 2>>"$LOG" \
    || fail "$label archive failed"
  log "$label: $(du -h "$out" | awk '{print $1}')"
}

backup_volume "$MINIO_VOL" "minio"
backup_volume "$GIT_VOL" "git"

# --- 3. manifest ------------------------------------------------------------
# Records what a restore needs to know, so a future restore does not depend on
# remembering the stack's layout.
cat > "$DEST/buzz-manifest-$STAMP.txt" <<EOF
Buzz relay backup
created:        $(date -u '+%Y-%m-%dT%H:%M:%SZ')
host:           $(hostname)
pg container:   $CONTAINER
pg database:    $PGDB
pg user:        $PGUSER
pg version:     $(docker exec "$CONTAINER" pg_dump --version 2>/dev/null)
minio volume:   $MINIO_VOL
git volume:     $GIT_VOL
files:
  buzz-pg-$STAMP.dump        pg_dump custom format (-Fc)
  buzz-minio-$STAMP.tar.gz   minio /data
  buzz-git-$STAMP.tar.gz     relay git store
restore:        see ops/RESTORE.md in rimusz/agnt-buzz-cli-plugin
EOF

# --- 4. retention -----------------------------------------------------------
# find -delete rather than a recursive force-remove: it only ever matches the
# specific files this script writes, and cannot walk outside $DEST.
BEFORE=$(find "$DEST" -maxdepth 1 -type f -name 'buzz-*' | wc -l | tr -d ' ')
find "$DEST" -maxdepth 1 -type f -name 'buzz-pg-*.dump'    -mtime +"$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'buzz-minio-*.tar.gz' -mtime +"$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'buzz-git-*.tar.gz'   -mtime +"$KEEP_DAYS" -delete
find "$DEST" -maxdepth 1 -type f -name 'buzz-manifest-*.txt' -mtime +"$KEEP_DAYS" -delete
AFTER=$(find "$DEST" -maxdepth 1 -type f -name 'buzz-*' | wc -l | tr -d ' ')
[ "$BEFORE" -ne "$AFTER" ] && log "retention: pruned $((BEFORE - AFTER)) file(s) older than ${KEEP_DAYS}d"

# --- 5. optional deep verify ------------------------------------------------
# Restores into a throwaway database and counts rows. Proves the dump is not
# merely readable but actually loadable. Production database is never touched.
if [ "$VERIFY" -eq 1 ]; then
  SCRATCH="buzz_restore_verify_$$"
  log "verify: restoring into scratch database $SCRATCH"
  docker exec "$CONTAINER" createdb -U "$PGUSER" "$SCRATCH" 2>>"$LOG" \
    || fail "verify: could not create scratch database"
  # pg_restore reports non-fatal warnings on --no-owner dumps; only the row
  # count below decides success.
  docker exec -i "$CONTAINER" pg_restore -U "$PGUSER" -d "$SCRATCH" --no-owner \
    < "$DUMP" >>"$LOG" 2>&1 || true
  ROWS=$(docker exec "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -tAc \
    "select coalesce(sum(n_live_tup),0) from pg_stat_user_tables;" 2>>"$LOG" || echo 0)
  TABLES=$(docker exec "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -tAc \
    "select count(*) from information_schema.tables where table_schema='public';" 2>>"$LOG" || echo 0)
  docker exec "$CONTAINER" dropdb -U "$PGUSER" "$SCRATCH" 2>>"$LOG" || true
  [ "$TABLES" -gt 0 ] || fail "verify: restored database has no tables"
  log "verify: OK — restored $TABLES tables, $ROWS rows, scratch database dropped"
fi

# --- 6. optional full drill -------------------------------------------------
# Re-reads the archives FROM DISK and checks all three payloads, exactly as a
# real recovery would. Chaining this onto the nightly job means a snapshot is
# proven recoverable the moment it is taken, instead of the first time it is
# needed — which is the worst possible moment to discover otherwise.
DRILL_RC=0
if [ "$DRILL" -eq 1 ]; then
  if [ ! -x "$DRILL_BIN" ]; then
    log "drill: SKIPPED — restore-drill.sh not found or not executable at $DRILL_BIN"
    DRILL_RC=2
  else
    log "drill: running full recovery rehearsal against $STAMP"
    if BUZZ_BACKUP_DIR="$DEST" "$DRILL_BIN" "$STAMP" >>"$LOG" 2>&1; then
      log "drill: PASSED — snapshot $STAMP is proven recoverable"
    else
      DRILL_RC=2
      # Deliberately NOT deleted. A snapshot the drill rejects is the single
      # most useful thing to have on disk while working out why, and removing
      # it would also leave the previous good one as the newest — quietly
      # hiding that anything went wrong.
      log "drill: FAILED — snapshot $STAMP did NOT verify. Kept on disk for inspection."
      log "drill: investigate with: $DRILL_BIN $STAMP"
    fi
  fi
fi

TOTAL=$(du -sh "$DEST" | awk '{print $1}')
log "=== done. $(find "$DEST" -maxdepth 1 -name 'buzz-pg-*.dump' | wc -l | tr -d ' ') snapshot(s) retained, $TOTAL total"

# The backup itself succeeded either way — the files are written and retained.
# Exit 2 reports that the snapshot is not trustworthy, so launchd records a
# failure and a caller chaining on success does not treat it as verified.
exit "$DRILL_RC"
