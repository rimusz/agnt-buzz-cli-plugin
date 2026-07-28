---
name: buzz-setup
description: >-
  Install, configure, or repair Buzz + AGNT integration: buzz CLI, BUZZ_* env,
  local or remote relay URL, agent Nostr identity, buzz-cli-plugin, and optional
  DM poller. Use when the user says "setup Buzz", "connect Annie to Buzz",
  "point AGNT at relay", "Buzz on another host", "Tailscale Buzz URL",
  "install buzz-cli-plugin", or "why no community for this host".
metadata:
  short-description: "Setup Buzz CLI + AGNT plugin (local or remote relay)"
---

# Skill: buzz-setup

Bring up or repair **Block Buzz** for AGNT so agents can use channels/DMs via the official CLI.

## Constants (this lab machine — override on other hosts)

| Item | Default / example |
|------|-------------------|
| AGNT repo | `/Users/tom/.agnt-server` |
| Plugin dev | `backend/plugins/dev/buzz-cli-plugin/` |
| Docs | `…/buzz-cli-plugin/docs/ARCHITECTURE.md`, `SETUP-CHECKLIST.md` |
| CLI binary | `/Users/tom/.cargo/bin/buzz` |
| Annie nsec | `/Users/tom/.buzz/annie.nsec` |
| Annie identity JSON | `/Users/tom/.buzz/annie.identity.json` |
| Example relay (Tailscale) | `https://relay.example.com` |
| Poller | `/Users/tom/.agnt/annie-buzz-poller/` |
| Backend LaunchAgent | `ai.agnt.backend` |
| **CLI resolve order** | **`BUZZ_BIN` → PATH → fallbacks** (see ARCHITECTURE.md) |

## Critical: relay can be local OR remote

`BUZZ_RELAY_URL` is any reachable community base URL:

| Topology | Example | Watch-outs |
|----------|---------|------------|
| Same host, simple relay | `http://127.0.0.1:3000` | OK only if community not Host-bound |
| Same host, compose/Caddy/Tailscale | `https://hostname.ts.net` | **Do not** use localhost if Host selects community |
| Remote VPS / teammate | `https://buzz.example.com` | Outbound HTTPS + membership invite |
| Remote Tailscale | `https://other-node.ts.net` | AGNT host must be on tailnet |

**Rule:** use the **same URL that opens the Buzz UI** in a browser on the AGNT machine.

### Host / community failure

Symptom: `relay error 404: no community is configured for this host`

Fix:

1. Read deploy env `BUZZ_DOMAIN` or ask operator for public URL.
2. Set `BUZZ_RELAY_URL=https://$BUZZ_DOMAIN` (or correct remote URL).
3. Verify: `curl` + `buzz users get`.
4. Update AGNT `.env` + poller `config.json` + restart backend/poller.

## Procedure

### 1) Discover current state

`which buzz` often fails under LaunchAgent / minimal PATH even when the binary exists.
**Always resolve the CLI in this order** before declaring it missing:

```bash
# 1) Prefer explicit env (AGNT .env or shell)
#    source or parse BUZZ_BIN from ~/.agnt-server/.env if needed
if [ -n "${BUZZ_BIN:-}" ] && [ -x "$BUZZ_BIN" ]; then
  BUZZ="$BUZZ_BIN"
elif command -v buzz >/dev/null 2>&1; then
  BUZZ="$(command -v buzz)"
else
  for c in \
    "$HOME/.cargo/bin/buzz" \
    /opt/homebrew/bin/buzz \
    /usr/local/bin/buzz \
    "$HOME/.local/bin/buzz"
  do
    [ -x "$c" ] && BUZZ="$c" && break
  done
fi

echo "BUZZ_CLI=${BUZZ:-NOT_FOUND}"
[ -n "${BUZZ:-}" ] && "$BUZZ" --help | head -20

# env (redact keys in output to user)
grep -E '^BUZZ_' ~/.agnt-server/.env 2>/dev/null | sed 's/=.*/=…/'
# If BUZZ_BIN is set in .env but empty in shell, treat that path as BUZZ above.

RELAY="${BUZZ_RELAY_URL:-}"
[ -z "$RELAY" ] && RELAY="$(grep -E '^BUZZ_RELAY_URL=' ~/.agnt-server/.env 2>/dev/null | cut -d= -f2- | tr -d '\r' | head -1)"
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 10 "${RELAY:-http://127.0.0.1:3000}/" || true
```

Report: CLI path used (`BUZZ_BIN` vs PATH vs fallback)? Env set? Relay reachable? Topology guess (local vs remote).

**Pass criteria for CLI:** any resolvable executable path — not only `which buzz`.

### 2) Ensure CLI

If missing: install from `block/buzz` (`cargo install --path crates/buzz-cli`) or copy binary; set `BUZZ_BIN` absolute path for LaunchAgent.

### 3) Ensure identity

- Prefer dedicated agent key (`annie.nsec`), not owner.
- `buzz users get` must succeed with chosen key + relay URL.
- Never print full nsec in chat logs.

### 4) Write AGNT env

`~/.agnt-server/.env` (and `backend/.env` if needed):

```bash
BUZZ_PRIVATE_KEY=…      # from nsec file
BUZZ_RELAY_URL=https://…  # local hostname OR remote
BUZZ_BIN=/Users/tom/.cargo/bin/buzz
```

Restart:

```bash
launchctl kickstart -k "gui/$(id -u)/ai.agnt.backend"
```

### 5) Plugin

If tools missing:

```bash
cd ~/.agnt-server/backend/plugins
node cli/build-plugin.js buzz-cli-plugin
# install .agnt package + POST reload
```

Verify tool list includes `buzz-whoami`, `buzz-send-message`, etc.

### 6) Optional poller (always-on DMs)

```bash
# config.json relayUrl must match BUZZ_RELAY_URL
node ~/.agnt/annie-buzz-poller/poller.js --once
launchctl list | grep annie-buzz || true
```

If auth fails: refresh `~/.agnt/annie-buzz-poller/agnt.token`.

### 7) Smoke tests

| Step | Command / action | Pass |
|------|------------------|------|
| whoami | `buzz users get` | JSON display_name |
| channels | `buzz channels list` | array |
| send | `buzz messages send --channel <uuid> --content "ping"` | accepted |
| plugin | AGNT tool buzz-whoami | success |
| DM (if poller) | human DM → wait 60s | Annie reply |

## Remote relay extras

When relay ≠ AGNT host:

1. Confirm DNS/Tailscale from AGNT host (`ping` / `curl -vI https://…`).
2. Confirm TLS certs trusted (or corporate MITM).
3. Confirm agent pubkey is **member** on that community (admin invite).
4. Open firewall for **outbound** HTTPS from AGNT host only (relay inbound is on the remote side).
5. Document the remote URL in plugin `docs/SETUP-CHECKLIST.md` snapshot table.

## Same-host extras

1. Prefer Tailscale/HTTPS name over Docker published `localhost:3000` for multi-tenant relays.
2. Ensure Docker compose is up before AGNT poller starts (poller will error soft and retry).
3. LaunchAgent PATH is minimal — always set `BUZZ_BIN`.

## Do not

- Commit nsec or JWT.
- Collapse `grokai` (xAI API) with Buzz.
- Use Grok-Build CLI as the **chat** brain for long Buzz tool loops (timeouts); use GrokAI API.
- Assume `buzz dms list` is the only DM path — this install often uses a channel named `DM`; poller uses `channels list` + name filter.

## Done criteria

- [ ] `buzz users get` works with production `BUZZ_RELAY_URL`
- [ ] AGNT backend has env and plugin tools
- [ ] Optional: poller loaded and one live DM reply
- [ ] Topology (local vs remote) documented for the user in one sentence
