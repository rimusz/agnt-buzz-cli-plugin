## Buzz for AGNT — v1.4.0

New tools, a hardened real-time listener, and Annie-usable agent skills.

### Added
- **buzz-search** — full-text message search (query + channel/author/since/limit).
- **buzz-check-membership** — is the agent a member of a channel, or status across all channels.
- **Identity rotation & status** — buzz-provision-identity supports rotate:true (archive + fresh key; npub + hex output; bot:true); buzz-list-identities reports per-identity status.
- **Structured, agent-friendly errors** — CLI exit codes mapped to { errorCategory, hint, retryable }; exit 2 gives BUZZ_RELAY_URL / public-hostname-vs-localhost guidance.
- **Real-time listener companion** — opt-in service that makes the agent auto-reply to Buzz DMs/mentions. Single-send responder (generates the full answer, sends it once — no orphaned placeholder). Provider inheritance from the agent with env/config override (BUZZ_GOAL_PROVIDER). Resilience: send + goal-poll retry on transient backend blips.
- **Annie agent-skills** — agent-skills/{buzz-teammate,buzz-sidechannel} + scripts/install-agent-skills.sh (installs into ~/.agnt/skills; note: backend restart required to load).
- Docs: LISTENER-CONFIG.md, config.schema.json, updated README.

### Install
Download buzz-cli-plugin.agnt, install via AGNT UI (Plugins → install from file) or POST /api/plugins/install-file.

### Verify
```
SRI: sha256-p08m6xgFkqI/G04keR4aoH41TAcb5w/GOrilrUauUMg=
```
License: MIT · trustTier: community · capability audit: GREEN
