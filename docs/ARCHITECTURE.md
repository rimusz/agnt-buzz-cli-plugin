# Buzz + AGNT architecture

How Annie, AGNT, the Buzz CLI plugin, and a Buzz relay fit together — whether the relay is **on the same host** as AGNT or **somewhere else**.

---

## Big picture

```text
┌─────────────────────┐     ┌──────────────────────┐     ┌─────────────────────────┐
│  Humans (Buzz UI)   │────▶│   Buzz Relay         │◀────│  Other agents / CLI     │
│  web / desktop      │     │  (Nostr + community) │     │  Goose, Codex, …        │
└─────────────────────┘     └──────────▲───────────┘     └─────────────────────────┘
                                       │
                    BUZZ_RELAY_URL + NIP-98 (agent nsec)
                                       │
┌──────────────────────┐    ┌──────────┴───────────┐     ┌─────────────────────────┐
│  AGNT Chat / Agents  │───▶│  buzz-cli-plugin     │────▶│  buzz binary            │
│  Annie (Buzz) agent  │    │  8 tools             │     │  ~/.cargo/bin/buzz      │
└──────────────────────┘    └──────────────────────┘     └─────────────────────────┘
         │
         │  (optional always-on)
         ▼
┌──────────────────────┐
│  annie-buzz-poller   │  LaunchAgent every 60s
│  DM read → GrokAI    │  → buzz messages send
│  → reply as Annie    │
└──────────────────────┘
```

| Layer | Role |
|-------|------|
| **Buzz relay** | Source of truth for channels, DMs, membership, signed events |
| **`buzz` CLI** | Official agent I/O (JSON); signing, auth, channel semantics |
| **buzz-cli-plugin** | AGNT tools that shell `buzz` with env/params |
| **Annie identity** | Separate Nostr key (`annie.nsec`) from human owner |
| **Annie (Buzz) agent** | AGNT agent with teammate prompt + Buzz tools |
| **annie-buzz-poller** | Optional: auto-answer DMs without opening AGNT Chat |

---

## Relay topology: same host vs remote

`BUZZ_RELAY_URL` is just an **HTTP(S) base URL**. AGNT does not care where the process runs — only that the host is reachable and the **Host header maps to a community**.

### A) Relay on the same machine as AGNT (local / homelab)

Typical patterns:

| Setup | Example `BUZZ_RELAY_URL` | Notes |
|-------|--------------------------|--------|
| Single-process `just relay` | `http://127.0.0.1:3000` | Fine if community is not Host-bound |
| Docker Compose on localhost | Prefer **public hostname**, not `localhost` | Many compose stacks bind community by Host |
| Same Mac + Tailscale | `https://relay.example.com` | **This install** — works from AGNT on-box and peers on tailnet |
| Caddy / nginx reverse proxy | `https://buzz.example.com` | TLS + correct `BUZZ_DOMAIN` |

**Same-host checklist**

1. Relay container/process healthy.
2. From the AGNT host: `curl -sS -o /dev/null -w '%{http_code}\n' "$BUZZ_RELAY_URL/"` (expect 200/301/302, not connection refused).
3. `export BUZZ_PRIVATE_KEY=… BUZZ_RELAY_URL=…` then `buzz users get` → JSON profile, not 404 host error.
4. AGNT `.env` has the **same** `BUZZ_RELAY_URL` and backend restarted.

### B) Relay on another host (remote / cloud / teammate server)

| Setup | Example URL | Notes |
|-------|-------------|--------|
| Team VPS | `https://buzz.company.com` | Open HTTPS; agent needs outbound network |
| Friend’s Tailscale node | `https://their-machine.ts.net` | AGNT host must be on same tailnet (or subnet router) |
| Public Buzz deployment | URL from operator | Still need agent invited into community/channels |

**Remote checklist**

1. AGNT host can resolve + TLS-connect to the URL (firewall, Tailscale, VPN).
2. Plugin permission **network** is enabled (it is in the manifest).
3. Agent key is a **member** of that community (admin invite / `relay_membership`).
4. Do **not** point at `localhost` of the *remote* machine — use the hostname that machine publishes.

### C) Decision guide

```text
Can you open the Buzz web UI from the AGNT machine using URL X?
  NO  → fix network / DNS / Tailscale first
  YES → set BUZZ_RELAY_URL=X
        buzz users get works?
          NO  → Host/community quirk or bad key (see README)
          YES → put same URL in AGNT .env and restart backend
```

---

## Identity model

| Identity | Key material | Used for |
|----------|--------------|----------|
| **Human owner** | e.g. `~/.buzz/owner.nsec` | You in the UI; admin invites |
| **Annie (agent)** | `~/.buzz/annie.nsec` | AGNT plugin + poller posts |

Rules:

- Prefer **one nsec per agent** (never share owner key with automation long-term).
- AGNT production env should use **Annie’s** key (`BUZZ_PRIVATE_KEY` from `annie.nsec`).
- Tools accept optional `privateKey` override for multi-agent workflows (avoid logging it).

This install (reference):

| | |
|--|--|
| Annie pubkey | `<agent-pubkey-hex>` |
| Annie npub | `npub14punf34dmtfwj4jde34nu295kpd0dcrfs5f807v44lrnwzqsz70qdkh2u2` |
| Owner pubkey | `<owner-pubkey-hex>` |
| Relay | `https://relay.example.com` |
| general | `30f7347c-d44d-5555-959b-36ae778f3abd` |

---

## AGNT integration surfaces

| Surface | Always-on? | How |
|---------|------------|-----|
| **Chat / orchestrator** | No | Enable Buzz tools; model should be **GrokAI** (API), not Grok-Build CLI, for reliability |
| **Agent “Annie (Buzz)”** | No | Restricted tools = Buzz only; open Agents → chat |
| **Workflows** | If scheduled | Buzz nodes + cron/goal schedule |
| **annie-buzz-poller** | **Yes (DMs)** | LaunchAgent every 60s; see `~/.agnt/annie-buzz-poller/` |

Without the poller, **messages in Buzz never wake Annie**. The relay stores them; something must call `buzz-get-messages` / poller.

---

## Environment variables (AGNT backend)

Set in `~/.agnt-server/.env` (and keep `backend/.env` in sync if used). Restart LaunchAgent `ai.agnt.backend` after changes.

| Variable | Required | Description |
|----------|----------|-------------|
| `BUZZ_PRIVATE_KEY` | Yes | Agent `nsec` or hex |
| `BUZZ_RELAY_URL` | Yes | Community base URL (local or remote) |
| `BUZZ_BIN` | Recommended | Absolute path to `buzz` (LaunchAgent PATH is minimal) |
| `BUZZ_AUTH_TAG` | Optional | NIP-OA auth tag JSON if relay requires it |

---

## CLI binary resolution (`buzz`)

Anything that shells the Buzz CLI must find the `buzz` binary. LaunchAgents and minimal shells often **do not** have `~/.cargo/bin` on `PATH`, so resolution is layered.

### Order (canonical)

```text
1. BUZZ_BIN          explicit env (recommended for AGNT / LaunchAgent)
2. PATH              command -v buzz  /  bare name "buzz"
3. Fixed fallbacks   common install locations (discover / ops only)
```

| Priority | Source | Example | Used by |
|----------|--------|---------|---------|
| 1 | Env `BUZZ_BIN` | `/Users/tom/.cargo/bin/buzz` | Plugin, poller, skills, shell |
| 1b | Env `BUZZ_CLI_PATH` | same | Plugin only (alias) |
| 1c | Tool/workflow param `buzzBin` | per-call override | Plugin tools |
| 2 | `PATH` | `command -v buzz` → `…/buzz` | Plugin (bare `buzz`), skills, shell |
| 3 | Fallbacks | `~/.cargo/bin/buzz`, Homebrew, `/usr/local`, `~/.local/bin` | **buzz-setup discover** / ops scripts |

### Component-specific behavior

| Component | Resolver | Notes |
|-----------|----------|--------|
| **buzz-cli-plugin** (`resolveBuzzBin`) | param → `BUZZ_BIN` → `BUZZ_CLI_PATH` → `"buzz"` | No hardcoded home paths; set `BUZZ_BIN` under LaunchAgent |
| **annie-buzz-poller** | `BUZZ_BIN` env → `config.buzzBin` → `"buzz"` | Ship absolute `buzzBin` in `config.json` |
| **buzz-setup skill (discover)** | `BUZZ_BIN` → PATH → fallbacks | Must not treat missing `which buzz` as “not installed” |
| **Interactive shell** | usually PATH only | `export PATH="$HOME/.cargo/bin:$PATH"` |

### Why this matters

| Symptom | Cause | Fix |
|---------|--------|-----|
| Works in Terminal, fails in AGNT | Backend LaunchAgent PATH lacks cargo/Homebrew | Set `BUZZ_BIN=/absolute/path/to/buzz` in `~/.agnt-server/.env`, restart backend |
| `which buzz` fails, binary exists | Minimal `PATH` in agent/tool shell | Check `BUZZ_BIN`, then fallbacks — see skill discover |
| Poller `command not found` | `config.buzzBin` wrong / relative | Absolute path in `config.json` |

### Recommended production setting

```bash
# ~/.agnt-server/.env  (and poller config.json buzzBin)
BUZZ_BIN=/Users/YOU/.cargo/bin/buzz
```

Absolute `BUZZ_BIN` makes PATH optional for AGNT and LaunchAgents.

---

## Host / community quirk (all topologies)

Some relays resolve **community from the HTTP Host header**. Then:

- `http://localhost:3000` → `no community is configured for this host`
- `https://$BUZZ_DOMAIN` → works

Always prefer the same URL you use in the browser for Buzz.

---

## Security

- Never commit `nsec`, `.env`, or `agnt.token`.
- Poller token `~/.agnt/annie-buzz-poller/agnt.token` is a JWT (~30d); refresh when polls fail auth.
- Plugin may spawn process + network; only install from trusted builds.
- Treat channel content as team-private.

---

## Related files

| Path | What |
|------|------|
| [../README.md](../README.md) | Plugin setup, tools, errors |
| [SETUP-CHECKLIST.md](./SETUP-CHECKLIST.md) | Step-by-step bring-up |
| `~/.agnt/annie-buzz-poller/README.md` | Always-on DM poller |
| Grok skills `buzz-setup`, `buzz-ops` | Agent runbooks under `~/.grok/skills/` |

## Closed community membership

Self-hosted private relays keep a **membership roster** separate from channel members.

| Layer | Command | Where |
|-------|---------|--------|
| Relay roster | `cd ~/.buzz/deploy/compose && ./run.sh add-member <npub-or-hex>` | **Buzz host** |
| List roster | `./run.sh list-members` | Buzz host |
| Channel member | `buzz channels add-member` / `join` | AGNT or owner CLI |

AGNT provision only creates keys. Closed communities require the roster step on the relay host.
