---
name: claude-ops
description: >-
  Operate Anthropic Claude Code day-to-day from AGNT: run headless prompts,
  choose Claude-Code provider, diagnose auth and PATH issues, contrast with
  Anthropic API. Use when the user says "run Claude Code", "claude -p",
  "Claude-Code timed out", "claude-code auth", or "use Claude CLI for this".
metadata:
  short-description: "Operate Claude Code CLI via AGNT (claude-code)"
---

# Skill: claude-ops

Day-to-day **Claude Code CLI** usage after `claude-setup`.

## Mental model

```text
AGNT Chat provider = claude-code
    → LlmService special auth → Claude Code path
        → claude binary + ~/.claude credentials
        → Anthropic Claude Code backend

OR orchestrator brain (GrokAI) + occasional Claude CLI via shell/tool
```

| Prefer | For |
|--------|-----|
| **GrokAI / API brain** + tools | Multi-plugin turns (Buzz, web, etc.) |
| **Claude-Code** provider | Claude-native coding sessions |
| **`claude -p`** in shell | Debug / one-shot outside AGNT |

Avoid stacking multiple heavy CLIs (Codex + Claude + Grok-Build) as simultaneous chat brains.

## This install

| Item | Value |
|------|--------|
| Provider | `claude-code` / **Claude-Code** |
| Binary | `~/.local/bin/claude` (check `which claude`) |
| Creds | `~/.claude/.credentials.json` |
| Auth manager | `ClaudeCodeAuthManager.js` |
| Not the same as | `anthropic` API provider |

## Common tasks

### A) One-shot headless prompt (shell)

```bash
export PATH="$HOME/.local/bin:/opt/homebrew/bin:$PATH"
claude -p "Reply with exactly: claude-ok"
# Flags vary by version — `claude -p --help` / `claude --help`
```

### B) Use as AGNT chat provider

1. Chat → 🤖 → Provider **Claude-Code** → pick model.
2. Short test message first.
3. If stream hangs: switch brain back to **GrokAI**; use Claude only for focused coding.

### C) Auth refresh

```bash
claude login
# AGNT: Connectors → Claude-Code → disconnect/reconnect
curl -sS -H "Authorization: Bearer $AGNT_AUTH_TOKEN" \
  http://localhost:3333/api/providers/claude-code/auth/status
```

### D) “Works in terminal, dead in AGNT”

1. LaunchAgent PATH → set `CLAUDE_BIN` in `~/.agnt-server/.env`, restart backend.
2. Confirm backend user is the same OS user that owns `~/.claude`.
3. Check health endpoint vs terminal `claude -p`.

### E) Contrast Anthropic API vs Claude Code

| Need | Provider |
|------|----------|
| API key, standard Messages API | **Anthropic** |
| Claude Code subscription / CLI tools / local binary | **Claude-Code** |

## Diagnostics checklist

| Check | How |
|-------|-----|
| Binary | `which claude` · `claude --version` |
| Creds | `ls -l ~/.claude/.credentials.json` |
| Headless | `claude -p "ping"` |
| AGNT health | `claude-code` in connection-health |
| Status API | `GET /api/providers/claude-code/auth/status` |
| Env | `grep CLAUDE_ ~/.agnt-server/.env \| sed 's/=.*/=…/'` |

## Failures → fixes

| Symptom | Fix |
|---------|-----|
| Not authenticated | `claude login` / reconnect in UI |
| command not found in AGNT only | `CLAUDE_BIN=/full/path/claude` + restart |
| Permission denied on credentials | Fix ownership/mode under `~/.claude` |
| Model list empty | Re-auth; check status API; fallback models in providerConfigs |
| Long hang | Cancel run; use API brain; retry smaller prompt |

## Safety

- No credential JSON in replies.
- Scope file access; Claude Code can edit the tree.
- Say when actions are mutating.

## Related skills

| Skill | When |
|-------|------|
| `claude-setup` | Install/login/repair |
| `codex-setup` / `codex-ops` | OpenAI Codex CLI |
| `restore-grok-build-provider` | Grok Build local branch |
| `buzz-ops` | Buzz channels/DMs |
