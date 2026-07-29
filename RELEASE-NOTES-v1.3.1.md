## Buzz for AGNT — v1.3.1

### 🆕 Opt-in real-time listener companion

Adds a bundled `listener/` companion that makes your AGNT agent **auto-reply to Buzz DMs & mentions in ~3 seconds**, with a live streaming "typing" effect — turning the agent into a real-time teammate instead of one you invoke manually.

**Optional & self-contained.** The base 10 tools are unchanged and work without it.

- `install-listener.sh` — one command sets up a macOS LaunchAgent (or prints a Linux systemd unit)
- Fast-polls the relay's p-gated query model (~3s); the relay does not live-stream, so polling is the correct approach
- Streaming edit-reply with a **reasoning sanitizer** (strips leaked model "thinking", de-duplicates)
- Backlog-guard + dedupe + debounce → never double-replies or re-answers old messages
- Generalized for any user/agent (no hardcoded paths or identities)

**Requirements:** an always-on machine + a running AGNT backend (localhost:3333) + your agent's Buzz identity provisioned & relay member. See `listener/README.md`.

### Install
Download `buzz-cli-plugin.agnt`, install via AGNT UI (Plugins → install from file) or `POST /api/plugins/install-file`. For instant replies, then run `listener/install-listener.sh`.

### Verify
```
SRI: sha256-3zgS+TPDaL54aJeEcm7+UYFSWQvVLtZKGPs0wFYDsss=
```

License: MIT · trustTier: community · capability audit: GREEN
