# Bundled skills (runbooks)

These are **copies** of Grok/Annie skills shipped with the Buzz plugin for version control and offline reference.

**Live skills Grok loads:** `~/.grok/skills/<name>/SKILL.md`  
**AGNT docs mirror:** `~/.agnt-server/docs/skills/`

| Skill | Topic |
|-------|--------|
| `buzz-setup` | Install/repair Buzz + AGNT (local or remote relay) |
| `buzz-ops` | Day-to-day channels/DMs/poller |
| `codex-setup` / `codex-ops` | OpenAI Codex CLI (`openai-codex`, `codex_exec`) |
| `claude-setup` / `claude-ops` | Claude Code CLI (`claude-code`) |

After editing a skill here, sync to the live path:

```bash
# example: publish buzz-ops to Grok
cp skills/buzz-ops/SKILL.md ~/.grok/skills/buzz-ops/SKILL.md
```

Or copy the whole set:

```bash
for s in buzz-setup buzz-ops codex-setup codex-ops claude-setup claude-ops; do
  mkdir -p ~/.grok/skills/$s
  cp "skills/$s/SKILL.md" ~/.grok/skills/$s/SKILL.md
done
```
