---
name: claude-setup
description: >-
  Install, authenticate, or repair Anthropic Claude Code CLI integration with
  AGNT (provider claude-code / Claude-Code). Use when the user says "setup
  Claude Code", "connect Claude CLI", "claude login", "claude-code missing",
  "Claude Code not authenticated", or "fix Claude CLI provider". Separate
  from the Anthropic API-key provider.
metadata:
  short-description: "Setup Claude Code CLI + AGNT (claude-code)"
---

# Skill: claude-setup

Bring up or repair **Anthropic Claude Code CLI** as an AGNT local provider.

## Do not confuse

| AGNT key | What it is | Auth |
|----------|------------|------|
| **`claude-code`** / UI **Claude-Code** | Local **Claude Code** CLI + subscription/OAuth | `~/.claude/.credentials.json` (and related) |
| **`anthropic`** | Anthropic **API** keys | Remote vault / API key |

This skill is **only** for `claude-code`.

## Constants (this lab — override elsewhere)

| Item | Value |
|------|--------|
| AGNT repo | `/Users/tom/.agnt-server` |
| Auth manager | `backend/src/services/auth/ClaudeCodeAuthManager.js` |
| Auth scheme | `claude-code` (local: status, oauth-pkce, connect-token, refresh, disconnect) |
| Binary (typical) | `~/.local/bin/claude` or Homebrew path |
| Bin override | `CLAUDE_BIN` / path detection in auth manager |
| Credentials | `~/.claude/.credentials.json` |
| Config dir | `~/.claude/` |
| Provider config | `providerConfigs.js` key `claude-code` |
| Frontend | `CLI_PROVIDER_IDS` includes `claude-code`; display **Claude-Code** |
| Backend LaunchAgent | `ai.agnt.backend` |

## Prerequisites

1. **Claude Code CLI** installed ([Anthropic Claude Code](https://docs.anthropic.com/en/docs/claude-code) install path for the OS).
2. Eligible Anthropic/Claude account for CLI.
3. AGNT backend on `:3333`.

## Procedure

### 1) Discover state

```bash
which claude; claude --version 2>&1 | head -5
ls -la ~/.claude/.credentials.json 2>/dev/null
curl -sS -H "Authorization: Bearer $AGNT_AUTH_TOKEN" \
  http://localhost:3333/api/users/connection-health | jq '.data.providers[] | select(.provider|test("claude"))'
curl -sS -H "Authorization: Bearer $AGNT_AUTH_TOKEN" \
  http://localhost:3333/api/providers/claude-code/auth/status 2>/dev/null | head -c 600
```

### 2) Install CLI if missing

Follow current Anthropic docs (native installer / npm / brew — **use whatever this machine already standardizes on**).

```bash
claude --version
# If LaunchAgent cannot see binary:
# CLAUDE_BIN=/Users/tom/.local/bin/claude  → ~/.agnt-server/.env
```

### 3) Authenticate

**CLI:**

```bash
claude login
# or version-specific auth command from `claude --help`
```

**AGNT UI:** Connectors / Settings → **Claude-Code** → OAuth / token connect (scheme supports `oauth-pkce`, `connect-token`).

Credentials should land in `~/.claude/` (AGNT `ClaudeCodeAuthManager` reads the same files the CLI uses).

**Verify:**

```bash
claude -p "Reply with exactly: claude-ok" 2>&1 | tail -30
# or non-interactive flag set for your CLI version (-p / --print)
```

### 4) AGNT env (optional)

```bash
# ~/.agnt-server/.env
CLAUDE_BIN=/Users/tom/.local/bin/claude
# Optional workdir convention if you add one later:
# AGNT_CLAUDE_WORKDIR=/Users/tom/services/agnt-claude-work
```

```bash
launchctl kickstart -k "gui/$(id -u)/ai.agnt.backend"
```

### 5) Confirm AGNT surfaces

| Surface | Expect |
|---------|--------|
| Health | `claude-code: healthy` (when logged in) |
| Picker | **Claude-Code** as local provider |
| Status API | `available` / `apiUsable` true |
| Models | `GET /api/models/claude-code/models` or fallback list from providerConfigs |

### 6) Smoke as chat provider (short)

Select **Claude-Code** + a listed model → one-word reply test.  
For long agentic coding loops, prefer Claude as **tool/coding** path if available; keep multi-plugin orchestrator brain on a fast API provider if CLI hangs appear.

## Common failures

| Symptom | Cause | Fix |
|---------|--------|-----|
| Not authenticated | Empty/expired `~/.claude` credentials | `claude login` / Connectors reconnect |
| binary not found | PATH under launchd | `CLAUDE_BIN` absolute |
| OAuth browser never finishes | Headless session | Use device/token path AGNT exposes (`connect-token` / CLI login on a desktop) |
| Wrong provider | User picked **Anthropic** API | Switch to **Claude-Code** for CLI subscription |
| UI missing after upgrade | Stale `frontend/dist` | Rebuild frontend if source has provider |
| 401 after Claude account change | Stale credentials file | Logout + login; AGNT disconnect + reconnect |

## Security

- Treat `~/.claude/.credentials.json` as secret (600).
- Claude Code may read the working tree — use deliberate cwd.
- Don’t dump credential JSON into chat or logs.

## Done criteria

- [ ] `claude --version` works
- [ ] Credentials file present; CLI `-p` smoke OK
- [ ] AGNT `claude-code` healthy / status usable
- [ ] Short completion via AGNT provider or CLI
