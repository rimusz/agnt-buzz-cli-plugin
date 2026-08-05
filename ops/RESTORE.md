# Restoring a Buzz relay from backup

Backups are produced by [`backup-buzz.sh`](backup-buzz.sh). Each run writes four
files into the backup directory:

```
buzz-pg-<stamp>.dump        Postgres, custom format (-Fc)
buzz-minio-<stamp>.tar.gz   MinIO /data — attachments
buzz-git-<stamp>.tar.gz     relay git store
buzz-manifest-<stamp>.txt   container/volume names + versions for that snapshot
```

Read the manifest first — it records the container and volume names that
snapshot was taken from, so a restore does not depend on remembering the
layout.

## Before you start

> **Restoring overwrites live data.** Take a fresh backup first, even of a
> broken stack — it costs seconds and gives you a way back.

```sh
./backup-buzz.sh
```

## 1. Postgres

The relay must not be writing while you restore. Stop it, leaving the database
up:

```sh
docker stop buzz-prod-relay-1 buzz-prod-pair-relay-1
```

Restore into the existing database, replacing its contents:

```sh
docker exec -i buzz-prod-postgres-1 \
  pg_restore -U buzz -d buzz --clean --if-exists --no-owner \
  < buzz-pg-<stamp>.dump
```

`--clean --if-exists` drops each object before recreating it, so a partially
populated database does not cause conflicts. Some notices are normal.

**To restore somewhere safe instead** — recommended when you are unsure — load
into a scratch database and inspect it before touching production:

```sh
docker exec buzz-prod-postgres-1 createdb -U buzz buzz_check
docker exec -i buzz-prod-postgres-1 pg_restore -U buzz -d buzz_check --no-owner < buzz-pg-<stamp>.dump
docker exec buzz-prod-postgres-1 psql -U buzz -d buzz_check -c \
  "select relname, n_live_tup from pg_stat_user_tables order by n_live_tup desc limit 10;"
docker exec buzz-prod-postgres-1 dropdb -U buzz buzz_check    # when finished
```

## 2. MinIO attachments and the git store

Volume contents are replaced by extracting over them. Stop the consuming
container first:

```sh
docker stop buzz-prod-minio-1

docker run --rm \
  -v buzz-prod_buzz-minio-data:/dst \
  -v "$PWD":/backup \
  postgres:17-alpine \
  sh -c 'cd /dst && tar xzf /backup/buzz-minio-<stamp>.tar.gz'

docker start buzz-prod-minio-1
```

Same shape for the git store, using `buzz-prod_buzz-git-data` and
`buzz-git-<stamp>.tar.gz` (the relay container consumes that one).

## 3. Bring the stack back

```sh
docker start buzz-prod-relay-1 buzz-prod-pair-relay-1
docker ps --format '{{.Names}}  {{.Status}}'      # all should report (healthy)
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3000/
```

Then confirm the listener reconnects — it retries with exponential backoff and
should come back within a minute or so:

```sh
tail -5 ~/.agnt/annie-buzz-listener/listener.log
```

Expect `relay-socket: OPEN` followed by `AUTH accepted`.

## Total loss of the Docker volumes

If the volumes are gone rather than damaged, recreate the stack first so the
schema and volumes exist, then restore as above:

```sh
cd ~/.buzz && docker compose up -d
```

Wait for `buzz-prod-postgres-1` to report `(healthy)` before running
`pg_restore`.

## Verifying a backup without restoring anything

`backup-buzz.sh --verify` restores the dump into a throwaway database, counts
the tables and rows, and drops it again. Production is never touched. Worth
running periodically — an untested backup is a hope, not a plan.
