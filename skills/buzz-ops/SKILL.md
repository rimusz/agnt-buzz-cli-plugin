---
name: buzz-ops
description: >-
  Operate Buzz day-to-day from AGNT/Annie: read channels and DMs, send and
  thread replies, post diffs, manage poller, diagnose silent agent. Use when
  user says "check Buzz", "reply in general", "Annie didn't answer DM",
  "summarize channel", "post to Buzz", "poller status", or "Buzz message".
metadata:
  short-description: "Operate Buzz channels/DMs/poller as Annie"
---

# Skill: buzz-ops

Day-to-day **Buzz operations** for Annie / AGNT after setup (`buzz-setup` skill).

## Mental model

- **Buzz relay** stores messages (local or remote URL in `BUZZ_RELAY_URL`).
- **Annie** only acts when AGNT tools run **or** `annie-buzz-poller` ticks (~60s).
- Posting identity = `BUZZ_PRIVATE_KEY` (should be Annie nsec).

If user expects instant DM replies and poller is stopped → start poller or reply manually.

## This install (override if different)

| Item | Value |
|------|--------|
| Relay | `https://relay.example.com` |
| Annie pubkey | `<agent-pubkey-hex>` |
| general | `30f7347c-d44d-5555-959b-36ae778f3abd` |
| CLI | `/Users/tom/.cargo/bin/buzz` |
| Poller | `~/.agnt/annie-buzz-poller` |
| Agent | Annie (Buzz) `3be1b009-64bb-4489-bba5-c574ba72a651` |

Load env without echoing secrets:

```bash
export BUZZ_BIN="${BUZZ_BIN:-/Users/tom/.cargo/bin/buzz}"
export BUZZ_RELAY_URL="${BUZZ_RELAY_URL:-https://relay.example.com}"
export BUZZ_PRIVATE_KEY="$(tr -d '[:space:]' < ~/.buzz/annie.nsec)"
export PATH="$HOME/.cargo/bin:$PATH"
```

## Tool map (plugin ↔ CLI)

| AGNT tool | CLI | Use |
|-----------|-----|-----|
| buzz-whoami | `buzz users get` | Confirm identity |
| buzz-list-channels | `buzz channels list` | Discover UUIDs |
| buzz-join-channel | `buzz channels join --channel UUID` | Join |
| buzz-get-messages | `buzz messages get --channel UUID [--limit N]` | Read |
| buzz-send-message | `buzz messages send --channel UUID --content "…" [--reply-to EVENT]` | Post / thread |
| buzz-get-thread | `buzz messages thread …` | Thread context |
| buzz-send-diff | `buzz messages send-diff …` | Patches |
| buzz-create-channel | `buzz channels create …` | New room |

**Flag style:** current CLI wants `--channel` / `--content`, not positional UUIDs.

Prefer **AGNT plugin tools** when inside AGNT; use CLI for shell diagnostics.

## Common tasks

### A) “What did I miss in general?”

1. `buzz channels list` (or list-channels tool)
2. `buzz messages get --channel 30f7347c-… --limit 30`
3. Summarize for user in AGNT; only post back if asked

### B) “Reply to my DM”

1. Find DM channel id (name `DM` or from list)
2. `messages get --channel <dm> --limit 20`
3. Draft reply; `messages send --channel <dm> --content "…" --reply-to <parent_event_id>`
4. Confirm event id + read-back

### C) “Annie silent in Buzz”

Checklist:

| Check | Command |
|-------|---------|
| Identity | `buzz users get` → Annie |
| Relay | URL reachable; not localhost quirk |
| Messages exist | `messages get` on DM shows human lines |
| Poller running | `launchctl list \| grep annie-buzz` |
| Poller log | `tail -30 ~/.agnt/annie-buzz-poller/poller.log` |
| Poller auth | `node …/poller.js --once` — JWT errors → refresh `agnt.token` |
| AGNT up | `curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3333/` |

Manual catch-up reply is OK while fixing poller.

### D) Poller ops

```bash
node ~/.agnt/annie-buzz-poller/poller.js --status
node ~/.agnt/annie-buzz-poller/poller.js --once
node ~/.agnt/annie-buzz-poller/poller.js --reseed   # forget cursors; no hist flood

# stop / start
launchctl bootout gui/$(id -u)/com.agnt.annie-buzz-poller
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.agnt.annie-buzz-poller.plist
```

`config.json`:

- `replyMode`: `dms_only` (default) or `all_channels`
- `relayUrl` must match active relay (local hostname or remote)

### E) Post as Annie from shell (no AGNT UI)

```bash
buzz messages send --channel <UUID> --content "Hello from Annie"
```

### F) Remote relay switch

If user moves relay off-box:

1. New URL works in browser from AGNT host
2. Update `~/.agnt-server/.env` `BUZZ_RELAY_URL`
3. Update poller `config.json` `relayUrl`
4. Restart `ai.agnt.backend` + poller LaunchAgent
5. `buzz users get` + one test send
6. Confirm membership still valid on new community

## Reply style (when drafting as Annie)

- Short, teammate voice; 1–4 sentences for DMs unless asked for depth
- No secrets, no nsec, no raw JWT
- Prefer `--reply-to` for threads
- After send: report channel name, short quote, event id

## Chat provider note

For multi-step Buzz tool use in AGNT Chat, prefer **GrokAI** (API). **Grok-Build** as chat brain can hang ~15 minutes on long turns.

## Escalation

| Problem | Skill / doc |
|---------|-------------|
| Greenfield install | `buzz-setup` |
| Architecture / topology | `docs/ARCHITECTURE.md` |
| Grok-Build provider missing after upgrade | `restore-grok-build-provider` (unrelated but co-located) |

## Done criteria for a user ask

- Did the Buzz action (read/send/summary) with Annie identity
- Stated relay URL used (so local vs remote is clear)
- If DM auto-reply expected: confirmed poller status or explained gap
