---
name: codex-ops
description: >-
  Operate OpenAI Codex day-to-day from AGNT: run codex_exec, pick models,
  resume sessions, sandbox workdirs, diagnose auth/model errors. Use when the
  user says "run Codex", "codex_exec", "review with Codex", "Codex timed out",
  "wrong Codex model", or "resume Codex session".
metadata:
  short-description: "Operate Codex CLI via AGNT (codex_exec)"
---

# Skill: codex-ops

Day-to-day **Codex** usage after `codex-setup`.

## Mental model

```text
Annie / orchestrator (API brain: GrokAI, etc.)
    → tool codex_exec
        → CodexCliService spawn: codex exec …
            → ~/.codex/auth.json
            → OpenAI Codex backend
```

- **Chat brain** should usually stay on an API provider (GrokAI, etc.).
- **Codex** is best as a **coding sub-agent** via `codex_exec`, not as the long multi-tool chat brain (same hang class as Grok-Build CLI).

## This install

| Item | Value |
|------|--------|
| Provider | `openai-codex` / **OpenAI-Codex** |
| Tool | `codex_exec` |
| Binary | `/opt/homebrew/bin/codex` (override `CODEX_BIN`) |
| Auth | `~/.codex/auth.json` |
| Workdir default | `~/services/agnt-codex-work` (`AGNT_CODEX_WORKDIR`) |
| CLI version (lab) | check `codex --version` |

## Tool: `codex_exec` (typical params)

| Param | Purpose |
|-------|---------|
| `prompt` | Task for Codex (required) |
| `model` | Optional; if rejected, AGNT retries without model flag |
| `cwd` | Repo/sandbox path (default AGNT_CODEX_WORKDIR) |
| `resume` / `sessionId` | Continue prior Codex thread |
| `sessionScope` | `conversation` \| `user` |
| `fullAuto` / approvals | Match AGNT outer approval layer |
| `extraArgs` | Escape hatch for CLI flags |

Prefer **explicit cwd** to a project under workspace or `agnt-codex-work`.

## Common tasks

### A) One-shot coding task

```text
codex_exec:
  prompt: "In cwd, add a README section explaining X. Do not touch unrelated files."
  cwd: /Users/tom/services/agnt-codex-work/my-proj
```

### B) Resume

Use `resume: true` with same conversation scope, or pass `sessionId` from a prior tool result.

### C) Shell equivalent (debug)

```bash
export PATH="/opt/homebrew/bin:$PATH"
cd "${AGNT_CODEX_WORKDIR:-$HOME/services/agnt-codex-work}"
codex exec "Reply with exactly: codex-ok" --skip-git-repo-check
codex doctor
```

### D) Auth expired mid-day

```bash
codex login
# or AGNT Connectors → OpenAI-Codex → reconnect
curl -sS -H "Authorization: Bearer $AGNT_AUTH_TOKEN" \
  http://localhost:3333/api/providers/openai-codex/auth/status
```

### E) Model errors (“not supported with ChatGPT account”)

1. Clear forced model / set `AGNT_CODEX_DEFAULT_MODEL` to a model the account allows.
2. Rely on AGNT retry-without-model behavior in `CodexCliService`.
3. Confirm with `codex exec` without `-m`.

### F) Slow / stuck runs

- Codex CLI can run long; set expectations (minutes, not seconds).
- Don’t stack Codex-as-chat-brain + heavy tools.
- Check no orphaned `codex` processes if user cancelled UI: `pgrep -lf codex`.

## Diagnostics checklist

| Check | Command / API |
|-------|----------------|
| CLI present | `which codex` |
| Auth file | `ls -l ~/.codex/auth.json` |
| Doctor | `codex doctor` |
| AGNT health | connection-health → `openai-codex` |
| Status API | `GET /api/providers/openai-codex/auth/status` |
| Workdir | `ls $AGNT_CODEX_WORKDIR` |

## Safety

- Keep cwd sandboxed; avoid `/` or full home.
- Don’t paste `auth.json` contents into chat.
- Say when Codex will edit files; prefer git-clean or dedicated branch.

## Related skills

| Skill | When |
|-------|------|
| `codex-setup` | Install/login/repair |
| `claude-setup` / `claude-ops` | Anthropic Claude Code CLI (different binary) |
| `restore-grok-build-provider` | Grok Build CLI branch restore |
| `buzz-ops` | Buzz messaging (unrelated) |
