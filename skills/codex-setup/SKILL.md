---
name: codex-setup
description: >-
  Install, authenticate, or repair OpenAI Codex CLI integration with AGNT
  (provider openai-codex / OpenAI-Codex, tool codex_exec). Use when the user
  says "setup Codex", "connect Codex", "codex login", "openai-codex missing",
  "codex_exec failed", "Codex not authenticated", or "fix Codex CLI".
  Separate from the plain OpenAI API-key provider.
metadata:
  short-description: "Setup OpenAI Codex CLI + AGNT (openai-codex)"
---

# Skill: codex-setup

Bring up or repair **OpenAI Codex CLI** as an AGNT local provider and coding tool.

## Do not confuse

| AGNT key | What it is | Auth |
|----------|------------|------|
| **`openai-codex`** / UI **OpenAI-Codex** | Local **Codex CLI** + ChatGPT/Codex OAuth | `~/.codex/auth.json` |
| **`openai`** | OpenAI **API** (platform.openai.com keys) | Remote vault / API key |

This skill is **only** for `openai-codex`.

## Constants (this lab — override elsewhere)

| Item | Value |
|------|--------|
| AGNT repo | `/Users/tom/.agnt-server` |
| Auth manager | `backend/src/services/auth/CodexAuthManager.js` |
| CLI service | `backend/src/services/ai/CodexCliService.js` |
| Client / sessions | `CodexCliClient.js`, `CodexCliSessionManager.js` |
| Orchestrator tool | `codex_exec` in `backend/src/services/orchestrator/tools.js` |
| Auth scheme | `codex` (local, device-auth) in `AuthDispatcher.js` |
| Binary (typical) | `/opt/homebrew/bin/codex` |
| Auth file | `~/.codex/auth.json` |
| Home override | `CODEX_HOME` (default `~/.codex`) |
| Bin override | `CODEX_BIN` |
| Default workdir | `AGNT_CODEX_WORKDIR` → `~/services/agnt-codex-work` |
| Default model env | `AGNT_CODEX_DEFAULT_MODEL` (ChatGPT accounts often reject `gpt-5-codex`; AGNT retries account default) |
| Backend LaunchAgent | `ai.agnt.backend` |

## Prerequisites

1. **Codex CLI** installed (`brew install codex` or OpenAI installer).
2. **Network** to OpenAI auth + Codex backend.
3. AGNT backend running on `:3333`.

## Procedure

### 1) Discover state

```bash
which codex; codex --version
ls -la ~/.codex/auth.json 2>/dev/null
# Health (needs AGNT token):
curl -sS -H "Authorization: Bearer $AGNT_AUTH_TOKEN" \
  http://localhost:3333/api/users/connection-health | jq '.data.providers[] | select(.provider|test("codex"))'
curl -sS -H "Authorization: Bearer $AGNT_AUTH_TOKEN" \
  http://localhost:3333/api/providers/openai-codex/auth/status 2>/dev/null | head -c 500
```

### 2) Install CLI if missing

```bash
brew install codex   # or official install path for the OS
codex --version
# Optional absolute path for sparse LaunchAgent PATH:
# echo 'CODEX_BIN=/opt/homebrew/bin/codex' >> ~/.agnt-server/.env
```

### 3) Authenticate

**Preferred (desktop):**

```bash
codex login
# or device flow for headless:
codex login --device-auth   # if supported by installed version
```

**Via AGNT UI:** Settings / Connectors → **OpenAI-Codex** → device login (AGNT shells the same OAuth/device flow and writes `~/.codex/auth.json`).

**Verify:**

```bash
codex doctor 2>&1 | head -40
# non-interactive smoke:
codex exec "Reply with exactly: codex-ok" --skip-git-repo-check 2>&1 | tail -20
```

Expect auth file present and doctor/exec not saying logged out.

### 4) AGNT env (optional but recommended)

`~/.agnt-server/.env`:

```bash
CODEX_BIN=/opt/homebrew/bin/codex
# CODEX_HOME=/Users/tom/.codex
AGNT_CODEX_WORKDIR=/Users/tom/services/agnt-codex-work
# AGNT_CODEX_DEFAULT_MODEL=gpt-5.5   # only if you know the account supports it
```

```bash
mkdir -p "$AGNT_CODEX_WORKDIR"
launchctl kickstart -k "gui/$(id -u)/ai.agnt.backend"
```

### 5) Confirm AGNT surfaces

| Surface | Expect |
|---------|--------|
| Connection health | `openai-codex: healthy` |
| Provider picker | **OpenAI-Codex** listed (local CLI) |
| Tool | `codex_exec` in orchestrator tool list / shell group |
| Models | `GET /api/models/openai-codex/models` returns list or fallback |

### 6) Smoke via tool path

In AGNT Chat (prefer **GrokAI** or other API as *brain*, tools on):

> Use codex_exec with prompt: "Reply with exactly: codex-tool-ok" and a sandbox cwd under AGNT_CODEX_WORKDIR.

Or shell the same `codex exec` as above.

## Common failures

| Symptom | Cause | Fix |
|---------|--------|-----|
| Not authenticated | Missing/expired `~/.codex/auth.json` | `codex login` / Connectors device-auth |
| Model not supported (ChatGPT account) | Hardcoded codex model id | Unset bad model; set `AGNT_CODEX_DEFAULT_MODEL` to account default; AGNT auto-retries without `-m` |
| binary not found | LaunchAgent PATH | Set `CODEX_BIN` absolute |
| Workdir errors | Missing sandbox | `mkdir -p ~/services/agnt-codex-work` |
| Confused with OpenAI API | Wrong provider key | Use **OpenAI-Codex**, not **OpenAI** |
| UI missing after upgrade | Frontend dist stale | `cd frontend && npm run build` + hard refresh (if source still has provider) |

## Security

- `~/.codex/auth.json` is a secret (tokens). Mode 600.
- Default coding cwd should be a **sandbox**, not `$HOME`.
- Codex may upload repo context to OpenAI — only point cwd at repos you accept sharing.

## Done criteria

- [ ] `codex --version` works
- [ ] `~/.codex/auth.json` exists; doctor/login OK
- [ ] AGNT health `openai-codex: healthy`
- [ ] `codex_exec` or `codex exec` returns a short completion
