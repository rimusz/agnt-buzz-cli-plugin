# ops — running a self-hosted Buzz relay

Operational tooling for a Buzz relay stack running under Docker on the same
host as the AGNT agent. Nothing here is required to use the plugin; it exists
because a self-hosted relay is only as durable as its backups.

| File | Purpose |
|---|---|
| [`backup-buzz.sh`](backup-buzz.sh) | Snapshot Postgres + MinIO + the git store, verify the dump, prune old copies |
| [`restore-drill.sh`](restore-drill.sh) | Rehearse a full recovery from an on-disk snapshot, without touching production |
| [`RESTORE.md`](RESTORE.md) | How to restore — including restoring somewhere safe first |
| [`launchd/`](launchd/) | Nightly schedule for macOS |

## Why

Everything a Buzz relay remembers — channels, messages, DMs, the audit log,
attachments — lives in Docker volumes. Volumes are easy to destroy:
`docker compose down -v`, a bad migration, a Docker Desktop reset. There is no
undo, and a relay with no history is not much of a workspace.

## Quick start

```sh
# one-off backup
./backup-buzz.sh

# backup, then prove the dump actually restores (into a throwaway database)
./backup-buzz.sh --verify

# rehearse a full recovery from what is already on disk
./restore-drill.sh --list      # available snapshots
./restore-drill.sh             # drill the most recent one
./restore-drill.sh <stamp>     # drill a specific one
```

`--verify` and the drill answer different questions. `--verify` checks the dump
the same run just produced, and only the Postgres part. The drill starts from
the **archive files as they sit on disk** — what you would actually reach for in
an incident — and exercises all three payloads, comparing restored attachments
against the live volume file by file. It exits non-zero when a snapshot is not
trustworthy, so it can gate a release or run from cron.

Defaults suit a standard `buzz-prod` compose stack; override with
`BUZZ_BACKUP_DIR`, `BUZZ_BACKUP_KEEP_DAYS`, `BUZZ_PG_CONTAINER`,
`BUZZ_MINIO_VOLUME`, `BUZZ_GIT_VOLUME`. See the header of the script.

## Scheduling (macOS)

```sh
mkdir -p ~/.agnt/buzz-backup
cp backup-buzz.sh ~/.agnt/buzz-backup/

sed -e "s|__SCRIPT__|$HOME/.agnt/buzz-backup/backup-buzz.sh|g" \
    -e "s|__DIR__|$HOME/.agnt/buzz-backup|g" \
    launchd/com.agnt.buzz-backup.plist.example \
  > ~/Library/LaunchAgents/com.agnt.buzz-backup.plist

plutil -lint ~/Library/LaunchAgents/com.agnt.buzz-backup.plist
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agnt.buzz-backup.plist
launchctl kickstart -k gui/$(id -u)/com.agnt.buzz-backup   # run once now
```

Retention defaults to 14 days. On a small relay that is a few tens of MB.

## What this does not do

The backup lands on the **same disk** as the volumes it is protecting. That
covers deleted volumes, a bad migration and corruption — not drive failure or
loss of the machine. Point `BUZZ_BACKUP_DIR` at external or synced storage if
you need that.

Run `./backup-buzz.sh --verify` occasionally. An untested backup is a hope, not
a plan.
