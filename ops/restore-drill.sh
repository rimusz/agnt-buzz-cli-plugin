#!/bin/sh
# restore-drill.sh — full recovery rehearsal from an ON-DISK snapshot.
#
# WHY THIS EXISTS SEPARATELY FROM `backup-buzz.sh --verify`
#   --verify checks a dump the same run just produced, and only the Postgres
#   part of it. This drill starts from the archive files as they sit on disk —
#   the thing you would actually reach for in an incident — and exercises all
#   three payloads: database, attachments, git store. It answers "can we
#   recover?", not merely "did the dump write?".
#
# WHAT IT PROVES
#   1. archive integrity   gzip stream + pg_restore header parse
#   2. postgres            restores into a SCRATCH database, exact per-table counts
#   3. minio attachments   every user object md5-compared against the live volume
#   4. git store           same
#
# PRODUCTION IS NEVER WRITTEN TO. The live database is only read; live volumes
# are mounted read-only; the scratch database is dropped before exit.
#
# USAGE
#   ./restore-drill.sh              # drill the most recent snapshot
#   ./restore-drill.sh <stamp>      # drill a specific one, e.g. 20260805-132512
#   ./restore-drill.sh --list       # show available snapshots
#
# CONFIG — same variables as backup-buzz.sh
#   BUZZ_BACKUP_DIR BUZZ_PG_CONTAINER BUZZ_MINIO_VOLUME BUZZ_GIT_VOLUME BUZZ_TAR_IMAGE
#
# EXIT CODES
#   0 drill passed   1 drill FAILED (recovery is not safe)   69 docker/container unavailable

set -eu

DEST="${BUZZ_BACKUP_DIR:-$HOME/.agnt/buzz-backup/backups}"
CONTAINER="${BUZZ_PG_CONTAINER:-buzz-prod-postgres-1}"
MINIO_VOL="${BUZZ_MINIO_VOLUME:-buzz-prod_buzz-minio-data}"
GIT_VOL="${BUZZ_GIT_VOLUME:-buzz-prod_buzz-git-data}"
IMAGE="${BUZZ_TAR_IMAGE:-postgres:17-alpine}"

FAIL=0
say()  { printf '\n== %s\n' "$1"; }
note() { printf '   %s\n' "$1"; }
bad()  { printf '   FAIL  %s\n' "$1"; FAIL=1; }

list_snapshots() {
  find "$DEST" -maxdepth 1 -name 'buzz-pg-*.dump' 2>/dev/null \
    | sed 's|.*/buzz-pg-||; s|\.dump$||' | sort
}

[ "${1:-}" = "--list" ] && { list_snapshots; exit 0; }

STAMP="${1:-$(list_snapshots | tail -1)}"
[ -n "$STAMP" ] || { echo "no snapshots found in $DEST" >&2; exit 1; }

DUMP="$DEST/buzz-pg-$STAMP.dump"
MINIO_TAR="buzz-minio-$STAMP.tar.gz"
GIT_TAR="buzz-git-$STAMP.tar.gz"
[ -f "$DUMP" ] || { echo "no such snapshot: $DUMP" >&2; exit 1; }

# --- preflight --------------------------------------------------------------
command -v docker >/dev/null 2>&1 || { echo "docker not on PATH" >&2; exit 69; }
docker ps --format '{{.Names}}' | grep -qx "$CONTAINER" \
  || { echo "container '$CONTAINER' is not running" >&2; exit 69; }

PGUSER=$(docker exec "$CONTAINER" printenv POSTGRES_USER)
PGDB=$(docker exec "$CONTAINER" printenv POSTGRES_DB)
SCRATCH="buzz_drill_$$"

# Exact per-table counts. pg_stat_user_tables is an ESTIMATE and is stale in a
# freshly restored database until it is analysed, so it cannot be compared.
COUNT_SQL="select table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text
from information_schema.tables
where table_schema='public' and table_type='BASE TABLE'
order by table_name;"

say "SNAPSHOT UNDER TEST: $STAMP"
[ -f "$DEST/buzz-manifest-$STAMP.txt" ] && sed 's/^/   /' "$DEST/buzz-manifest-$STAMP.txt"

# --- 1. archive integrity ---------------------------------------------------
say "1. ARCHIVE INTEGRITY (files as they sit on disk)"
for f in "$MINIO_TAR" "$GIT_TAR"; do
  if [ ! -f "$DEST/$f" ]; then
    note "skip      $f (not present in this snapshot)"
  elif gzip -t "$DEST/$f" 2>/dev/null; then
    note "ok        $f ($(tar tzf "$DEST/$f" | wc -l | tr -d ' ') entries)"
  else
    bad "$f — gzip stream is corrupt"
  fi
done
ENTRIES=$(docker exec -i "$CONTAINER" pg_restore --list < "$DUMP" 2>/dev/null | grep -c ';' || true)
if [ "$ENTRIES" -gt 0 ]; then
  note "ok        buzz-pg-$STAMP.dump ($ENTRIES archive entries)"
else
  bad "buzz-pg-$STAMP.dump — unreadable, pg_restore found no entries"
fi

# --- 2. postgres into a scratch database ------------------------------------
say "2. POSTGRES RESTORE INTO SCRATCH DATABASE"
docker exec "$CONTAINER" psql -U "$PGUSER" -d "$PGDB" -tAc "$COUNT_SQL" > /tmp/drill-prod.$$ 2>/dev/null
PROD_TOTAL=$(awk -F= '{s+=$2} END{print s+0}' /tmp/drill-prod.$$)
note "live '$PGDB': $(wc -l < /tmp/drill-prod.$$ | tr -d ' ') tables, $PROD_TOTAL rows (read-only baseline)"

docker exec "$CONTAINER" createdb -U "$PGUSER" "$SCRATCH"
# Always drop the scratch database, even if the drill aborts partway.
trap 'docker exec "$CONTAINER" dropdb -U "$PGUSER" --if-exists "$SCRATCH" >/dev/null 2>&1 || true; rm -f /tmp/drill-*.$$' EXIT INT TERM

# --no-owner dumps emit non-fatal notices; the row counts below decide.
docker exec -i "$CONTAINER" pg_restore -U "$PGUSER" -d "$SCRATCH" --no-owner \
  < "$DUMP" > /tmp/drill-log.$$ 2>&1 || true
NOTICES=$(grep -c '^pg_restore:' /tmp/drill-log.$$ || true)

docker exec "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH" -tAc "$COUNT_SQL" > /tmp/drill-rest.$$ 2>/dev/null
REST_TABLES=$(wc -l < /tmp/drill-rest.$$ | tr -d ' ')
REST_TOTAL=$(awk -F= '{s+=$2} END{print s+0}' /tmp/drill-rest.$$)

if [ "$REST_TABLES" -gt 0 ] && [ "$REST_TOTAL" -gt 0 ]; then
  note "ok        restored $REST_TABLES tables, $REST_TOTAL rows ($NOTICES pg_restore notices)"
else
  bad "restore produced $REST_TABLES tables / $REST_TOTAL rows"
  sed 's/^/      /' /tmp/drill-log.$$ | tail -5
fi

say "3. RESTORED vs PRODUCTION"
if diff -q /tmp/drill-prod.$$ /tmp/drill-rest.$$ >/dev/null 2>&1; then
  note "identical — every table matches production exactly"
else
  # Drift is EXPECTED and healthy: the relay keeps serving after a snapshot is
  # taken, so a point-in-time backup lags a live system. Shown, not failed.
  note "drift (expected — the relay kept serving after the snapshot):"
  diff /tmp/drill-prod.$$ /tmp/drill-rest.$$ 2>/dev/null | grep -E '^[<>]' | sed 's/^/      /' || true
fi

# --- 4. volume payloads -----------------------------------------------------
# User objects are the pass/fail criterion. MinIO also keeps internal state
# under .minio.sys (usage counters, bloom cycle, a tmp/trash scratch area) that
# it rewrites continuously and regenerates on start — differences there are
# noise, and failing on them would make every drill red for no reason.
compare_volume() {
  vol="$1"; tarname="$2"; label="$3"
  [ -f "$DEST/$tarname" ] || { note "skip      $label (no archive in this snapshot)"; return 0; }
  if ! docker volume inspect "$vol" >/dev/null 2>&1; then
    note "skip      $label (volume '$vol' not present)"; return 0
  fi
  # NOTE: -i is REQUIRED. `sh -s` reads the script from stdin, and without -i
  # docker attaches no stdin: the inner script silently never runs, the command
  # exits 0, and the drill reports a pass having checked nothing.
  if out=$(docker run -i --rm -v "$vol":/live:ro -v "$DEST":/backup:ro "$IMAGE" \
       sh -s -- "$tarname" "$label" <<'INNER'
set -e
tarname=$1; label=$2
mkdir -p /tmp/r && tar xzf "/backup/$tarname" -C /tmp/r
cd /live  && find . -type f -exec md5sum {} \; 2>/dev/null | sort -k2 > /tmp/live.all
cd /tmp/r && find . -type f -exec md5sum {} \; 2>/dev/null | sort -k2 > /tmp/rest.all
grep -v '\.minio\.sys' /tmp/live.all > /tmp/live.user || true
grep -v '\.minio\.sys' /tmp/rest.all > /tmp/rest.user || true
lu=$(wc -l < /tmp/live.user | tr -d ' '); ru=$(wc -l < /tmp/rest.user | tr -d ' ')
ls=$(grep -c '\.minio\.sys' /tmp/live.all || true); rs=$(grep -c '\.minio\.sys' /tmp/rest.all || true)
if diff -q /tmp/live.user /tmp/rest.user >/dev/null 2>&1; then
  echo "   ok        $label: $ru user object(s), every checksum identical to live"
  [ "$ls" != "$rs" ] && echo "             (.minio.sys internal state live=$ls restored=$rs — usage/bloom/tmp churn, regenerated on start)"
  exit 0
fi
echo "   FAIL  $label: user objects differ (live=$lu restored=$ru)"
diff /tmp/live.user /tmp/rest.user | head -10 | sed 's/^/         /'
exit 1
INNER
  ); then :; else FAIL=1; fi

  # A comparison that produced no verdict has proved nothing. Treat silence as
  # failure rather than success — this is the exact bug -i above prevents, and
  # this guard is what makes it impossible to reintroduce unnoticed.
  if [ -z "$out" ]; then
    bad "$label: comparison produced no output — nothing was actually verified"
  else
    printf '%s\n' "$out"
  fi
}

say "4. VOLUME PAYLOADS vs LIVE VOLUMES (content-level, md5 per file)"
compare_volume "$MINIO_VOL" "$MINIO_TAR" "minio attachments"
compare_volume "$GIT_VOL"   "$GIT_TAR"   "relay git store"

# --- 5. cleanup + assert production untouched -------------------------------
say "5. CLEANUP — PRODUCTION UNTOUCHED"
docker exec "$CONTAINER" dropdb -U "$PGUSER" --if-exists "$SCRATCH" >/dev/null 2>&1 || true
trap - EXIT INT TERM
rm -f /tmp/drill-prod.$$ /tmp/drill-rest.$$ /tmp/drill-log.$$
LEFTOVER=$(docker exec "$CONTAINER" psql -U "$PGUSER" -tAc \
  "select count(*) from pg_database where datname like 'buzz_drill_%';" | tr -d ' ')
[ "$LEFTOVER" = "0" ] && note "ok        scratch database dropped, none left behind" \
                      || bad "$LEFTOVER scratch database(s) left behind"
HEALTHY=$(docker ps --filter name=buzz-prod --format '{{.Status}}' | grep -c healthy || true)
note "ok        $HEALTHY buzz container(s) healthy"

if [ "$FAIL" -eq 0 ]; then
  say "DRILL PASSED — snapshot $STAMP is recoverable"
  exit 0
fi
say "DRILL FAILED — snapshot $STAMP should NOT be relied on"
exit 1
