# Changelog

## [1.3.1] - 2026-07-28

### Added
- **Opt-in real-time listener companion** (`listener/`) — an always-on service
  that makes the agent auto-reply to Buzz DMs & mentions in ~3s with a streaming
  "typing" effect. Fast-polls the relay's p-gated query model (the relay does not
  live-stream). Includes `install-listener.sh` (macOS LaunchAgent / Linux systemd),
  `config.template.json`, and a README. Generalized for any user/agent (no
  hardcoded paths or identities).
- Reply sanitizer that strips leaked model reasoning and de-duplicates, so posted
  replies are always clean.

### Notes
- The base 10 tools are unchanged and work without the listener.
- Listener requires an always-on machine + a running AGNT backend.


