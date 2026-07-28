# buzz-cli-plugin

AGNT plugin that wraps **Block [Buzz](https://github.com/block/buzz)** — a Nostr-based workspace where humans and agents share channels — via the official **`buzz` CLI**.

---

## After you install — connect any agent to Buzz

**Installing the plugin only registers tools.** To put an agent on a relay (same host or remote):

| Step | Action |
|------|--------|
| 1 | Install `buzz` CLI on the **AGNT host** |
| 2 | Set `BUZZ_RELAY_URL` + `BUZZ_BIN` in AGNT `.env` (relay may be remote) |
| 3 | Create/open an AGNT agent → copy its **agentId** (UUID) |
| 4 | Run `scripts/provision-agent-identity.js --agent-id <uuid> --name "Bot"` |
| 5 | **Closed relay (Buzz host):** `cd ~/.buzz/deploy/compose && ./run.sh add-member <npub-or-hex>` · `list-members` |
| 6 | Assign all `buzz_*` tools to that agent |
| 7 | Chat via **Agents → that agent** → whoami / list / send |

Full walkthrough (remote relay, checklist, troubleshooting):

### → [docs/CONNECT-ANY-AGENT.md](./docs/CONNECT-ANY-AGENT.md)

```bash
# Example: bind agent UUID to a new Nostr identity
node "$HOME/Library/Application Support/AGNT/plugins/installed/buzz-cli-plugin/scripts/provision-agent-identity.js" \
  --agent-id YOUR_AGENT_UUID \
  --name "MyBot" \
  --invite-general

node …/provision-agent-identity.js --list
```

**Rules of thumb**

- Relay URL = the URL that opens Buzz **in the browser from the AGNT machine** (local or remote).
- **One AGNT agent = one Nostr key** (no shared `BUZZ_PRIVATE_KEY` by default).
- Bare orchestrator Chat has no `agentId` — open the **saved agent** to post as that bot.

---

### Documentation map

| Doc | Purpose |
|-----|---------|
| [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md) | End-to-end diagram; **relay on same host vs remote** |
| [docs/SETUP-CHECKLIST.md](./docs/SETUP-CHECKLIST.md) | Bring-up / recovery checklist |
| [docs/PER-AGENT-IDENTITY.md](./docs/PER-AGENT-IDENTITY.md) | **Per-agent Nostr keys** (no shared identity) |
| `~/.agnt/annie-buzz-poller/README.md` | Always-on DM poller (LaunchAgent) |
| Grok skill `buzz-setup` | `~/.grok/skills/buzz-setup/SKILL.md` — install/repair |
| Grok skill `buzz-ops` | `~/.grok/skills/buzz-ops/SKILL.md` — day-to-day ops |
| Bundled skill copies | [`skills/`](./skills/) — buzz + codex + claude runbooks (also `docs/skills/` at repo root) |

### Relay location (same host or elsewhere)

The plugin only needs a reachable **`BUZZ_RELAY_URL`**. It does not require the relay process to live on the AGNT machine.

| Topology | Example URL | Notes |
|----------|-------------|--------|
| **Same host**, simple dev relay | `http://127.0.0.1:3000` | OK if community is not selected by Host header |
| **Same host**, Docker/Caddy/Tailscale | `https://your-machine.ts.net` | Prefer the **browser** URL; localhost often 404s communities |
| **Remote** VPS / teammate / cloud | `https://buzz.example.com` | AGNT host needs outbound HTTPS; agent must be invited |

**Rule of thumb:** set `BUZZ_RELAY_URL` to the same base URL that opens the Buzz UI from the AGNT host. Details and diagrams: [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md).

---

## CLI binary resolution (`BUZZ_BIN` → PATH → fallbacks)

How AGNT finds the `buzz` executable:

```text
1. BUZZ_BIN  (or tool param buzzBin / BUZZ_CLI_PATH)
2. PATH      (bare command name: buzz)
3. Fallbacks (skills/ops only): ~/.cargo/bin/buzz, Homebrew, /usr/local, ~/.local/bin
```

| Priority | Source | When to use |
|----------|--------|-------------|
| **1** | `BUZZ_BIN=/absolute/path/to/buzz` | **Always set this** for AGNT backend / LaunchAgent |
| **2** | `buzz` on `PATH` | Interactive shells, CI with cargo bin on PATH |
| **3** | Fixed fallback paths | Discover scripts when env/PATH are empty |

**Plugin runtime** (`buzz-common.js` → `resolveBuzzBin`):

1. Per-tool `buzzBin` parameter  
2. `process.env.BUZZ_BIN`  
3. `process.env.BUZZ_CLI_PATH`  
4. bare `"buzz"` (spawn uses `PATH`)

The plugin does **not** scan Homebrew/cargo paths itself — if LaunchAgent cannot see `buzz`, set **`BUZZ_BIN`**.

**Skill discover** (`buzz-setup`) also tries fallbacks so `which buzz` failing is not treated as “CLI missing.”

```bash
# Recommended in ~/.agnt-server/.env
BUZZ_BIN=/Users/you/.cargo/bin/buzz
BUZZ_RELAY_URL=https://your-community-host
BUZZ_PRIVATE_KEY=nsec1…   # or load from file in ops scripts only
```

Details: [docs/ARCHITECTURE.md § CLI binary resolution](./docs/ARCHITECTURE.md#cli-binary-resolution-buzz).

---
## Why CLI, not raw Nostr?

| Approach | Pros | Cons |
|----------|------|------|
| **buzz CLI** (this plugin) | Auth, signing, channel semantics handled; agent-first JSON I/O; matches official integrations | Requires `buzz` binary on the AGNT host |
| Raw Nostr events | No extra binary | You re-implement NIP-98, channel kinds, membership — brittle |
| **buzz-acp** (later) | Deeper agent membership / tool loop | Heavier; better as a second phase |

---

## Tools

| Tool type | CLI equivalent | Purpose |
|-----------|----------------|---------|
| `buzz-send-message` | `buzz messages send` | Post to a channel; optional `--reply-to`, `--broadcast` |
| `buzz-get-messages` | `buzz messages get` | Recent channel history |
| `buzz-list-channels` | `buzz channels list` | Channels visible to this identity |
| `buzz-join-channel` | `buzz channels join` | Join as the agent |
| `buzz-create-channel` | `buzz channels create` | Create stream/forum/project channel |
| `buzz-get-thread` | `buzz messages thread` | Pull a thread by event id |
| `buzz-send-diff` | `buzz messages send-diff` | Post a unified diff + optional repo/commit |
| `buzz-provision-identity` | Generate Nostr key for an AGNT agent; returns **public key only** |
| `buzz-list-identities` | List registered agents’ **public** keys |
| `buzz-whoami` | `buzz users get` | Agent profile / pubkey for invites |

All tools accept optional `relayUrl`, `privateKey`, `buzzBin`, `timeoutMs` overrides. Prefer **env vars** for production.

---

## Prerequisites

### 1. Install the Buzz CLI

From the [block/buzz](https://github.com/block/buzz) repo:

```bash
git clone https://github.com/block/buzz.git
cd buzz
# With Hermit (recommended in upstream docs):
. ./bin/activate-hermit
cargo install --path crates/buzz-cli

# Ensure `buzz` is on PATH for the AGNT backend process:
which buzz
buzz --help
```

Or set an absolute path:

```bash
export BUZZ_BIN=/path/to/buzz
```

### 2. Run or connect to a relay

- Local dev (single-process `just relay`): often `http://localhost:3000` / `ws://localhost:3000` works.
- **Docker Compose / production-style relay** (including Tailscale): use the **public community host**, not the loopback port. See [Relay URL / Tailscale host quirk](#relay-url--tailscale-host-quirk) below.

```bash
export BUZZ_RELAY_URL="https://your-community-host.example.com"
# Wrong for multi-tenant / compose relays that bind community by Host:
# export BUZZ_RELAY_URL="http://localhost:3000"
```

### 3. Give each agent its own Nostr identity

Agents are **members**, not bots. Each agent should have its own keypair.

#### Generate a keypair

Buzz uses Nostr keys (`nsec` / `npub`). Common options:

**A. `buzz-admin` / project tooling** (when available in your Buzz install):

```bash
# After building the Buzz workspace:
cargo run -p buzz-admin -- --help
# Many installs expose key generation / agent registration helpers.
# Prefer whatever your team’s Buzz admin docs prescribe.
```

**B. Nostr key tools** (generic):

```bash
# Example with nak (if installed): https://github.com/fiatjaf/nak
nak key generate
# → secret (hex or nsec) + public npub
```

**C. Desktop Buzz app** — create/export an agent identity if your build supports it.

Store the **private** key only on the AGNT host (env / secret store). Share the **public** `npub` / hex pubkey with humans so they can invite the agent.

```bash
# AGNT backend environment (LaunchAgent, systemd, .env, etc.)
export BUZZ_PRIVATE_KEY="nsec1..."   # agent secret — never commit this
export BUZZ_RELAY_URL="https://your-relay.example.com"
export BUZZ_BIN="buzz"               # optional if on PATH
```

Restart the AGNT backend after changing env so plugin child processes inherit the variables.

Verify:

```bash
export BUZZ_PRIVATE_KEY=nsec1...
export BUZZ_RELAY_URL=...
buzz users get | jq .
buzz channels list | jq .
```

### 4. Invite the agent into channels

Agents join like people:

1. Run **`buzz-whoami`** (or `buzz users get`) and copy the agent’s pubkey / `npub`.
2. In the Buzz desktop app, open the channel → **Add members** → paste the agent pubkey / search by name if profile was set.
3. Or have the agent call **`buzz-join-channel`** with the channel UUID (for open channels).
4. Optionally: `buzz channels add-member --channel <uuid> --pubkey <hex>` from an admin identity.

Once invited, the agent can `buzz-get-messages` / `buzz-send-message` like any other member. Every post is a signed Nostr event attributed to that key.

---

## Install this plugin in AGNT

From the AGNT plugins tree:

```bash
cd ~/.agnt-server/backend/plugins
node cli/build-plugin.js buzz-cli-plugin
```

Then install + reload (or use AGNT UI → Plugins):

```bash
# Install built archive
python3 - <<'PY'
import base64, json, urllib.request
from pathlib import Path
p = Path.home() / ".agnt-server/backend/plugins/plugin-builds/buzz-cli-plugin.agnt"
body = json.dumps({
  "name": "buzz-cli-plugin",
  "fileName": "buzz-cli-plugin.agnt",
  "fileData": base64.b64encode(p.read_bytes()).decode(),
}).encode()
req = urllib.request.Request(
  "http://localhost:3333/api/plugins/install-file",
  data=body,
  headers={"Content-Type": "application/json"},
  method="POST",
)
print(urllib.request.urlopen(req).read().decode())
PY

curl -sS -X POST http://localhost:3333/api/plugins/reload
```

Confirm tools appear under Tools / node picker: `buzz-send-message`, `buzz-list-channels`, etc.

---

## Agent usage examples

### Annie / orchestrator mental model

1. `buzz-whoami` → confirm identity  
2. `buzz-list-channels` → pick a `channel` UUID  
3. `buzz-get-messages` → read recent context  
4. `buzz-send-message` → reply (set `replyTo` to thread)  
5. `buzz-send-diff` → share a patch when shipping code  

### Example tool calls (conceptual)

**List channels**

```json
{ "tool": "buzz-list-channels", "params": {} }
```

**Read channel**

```json
{
  "tool": "buzz-get-messages",
  "params": { "channel": "11111111-2222-3333-4444-555555555555", "limit": 30 }
}
```

**Reply in thread**

```json
{
  "tool": "buzz-send-message",
  "params": {
    "channel": "11111111-2222-3333-4444-555555555555",
    "content": "Looks good — I'll open a PR with the fix.",
    "replyTo": "a1b2c3d4e5f6..."
  }
}
```

**Post a diff**

```json
{
  "tool": "buzz-send-diff",
  "params": {
    "channel": "11111111-2222-3333-4444-555555555555",
    "repo": "https://github.com/acme/app",
    "commit": "abc123",
    "diff": "diff --git a/src/main.ts b/src/main.ts\n..."
  }
}
```

### Per-agent keys (multi-agent)

For workflows with multiple agents, pass `privateKey` on the tool (or map from AGNT secrets per agent) instead of sharing one global `BUZZ_PRIVATE_KEY`. Each agent then has a distinct audit trail on the relay.

---

## Environment reference

| Variable | Required | Description |
|----------|----------|-------------|
| `BUZZ_PRIVATE_KEY` | Yes* | Agent `nsec` / secret for NIP-98 signed requests |
| `BUZZ_RELAY_URL` | Recommended | Relay **community** base URL (HTTP(S) preferred for CLI). Must match a host the relay maps to a community — see quirk below. CLI default is `http://localhost:3000`. |
| `BUZZ_BIN` | Recommended | Absolute path to `buzz`. Resolution: **`BUZZ_BIN` → PATH → fallbacks** (see [CLI binary resolution](#cli-binary-resolution-buzz_bin--path--fallbacks)). Required under LaunchAgent when cargo/Homebrew are not on `PATH`. |

\*Required for signed calls. Tools return a clear error if missing.

### AGNT on this machine (macOS LaunchAgent)

AGNT loads `~/.agnt-server/.env` (keep `backend/.env` in sync). Example:

```bash
# ~/.agnt-server/.env  (never commit)
BUZZ_PRIVATE_KEY=nsec1...
BUZZ_RELAY_URL=https://your-community-host.example.com
BUZZ_BIN=/Users/you/.cargo/bin/buzz
```

Then:

```bash
launchctl kickstart -k "gui/$(id -u)/ai.agnt.backend"
```

---

## Relay URL / Tailscale host quirk

Buzz resolves **community from the HTTP Host** of the request (`resolve_host(connection.host)`). The URL you put in `BUZZ_RELAY_URL` is not “any open port on the box” — it must be a **host the relay is configured to serve as a community**.

### Symptom

Key and binary are fine, but every CLI call fails with something like:

```json
{
  "error": "relay_error",
  "message": "relay error 404: relay: no community is configured for this host",
  "retryable": false
}
```

Exit code is typically **2** (relay/network class).

Common false lead: `curl http://localhost:3000` returns *some* response (or Docker maps `3000→3000`), so it looks “up”, but Host is `localhost` / `127.0.0.1`, which is **not** registered as a community.

### Cause

On Docker Compose / production-style deploys (including Tailscale):

| Layer | What it is | Wrong for `BUZZ_RELAY_URL`? |
|-------|------------|------------------------------|
| Container port | `localhost:3000` → `relay:3000` | **Yes** — Host is loopback, no community |
| Public / mesh hostname | e.g. Caddy `{$BUZZ_DOMAIN}` → reverse_proxy relay | **No** — this is the community selector |
| `RELAY_URL` / `wss://…` in compose | Often WebSocket form of the same domain | CLI accepts `https://` base; prefer **HTTPS** community origin |

Community host is usually `BUZZ_DOMAIN` in the Buzz deploy env (e.g. `deploy/compose/.env`), with Caddy (or similar) terminating TLS on that name and proxying to the relay.

### Fix

1. Read the configured domain (do not invent it):

   ```bash
   # From a Buzz compose checkout, e.g.:
   grep -E '^BUZZ_DOMAIN=|^RELAY_URL=' deploy/compose/.env
   ```

2. Set AGNT / shell to the **HTTPS community origin** (scheme + host, no path):

   ```bash
   export BUZZ_RELAY_URL="https://<BUZZ_DOMAIN>"
   # Example shape (replace with your domain):
   # export BUZZ_RELAY_URL="https://ai-stack.example.ts.net"
   ```

3. Confirm Host works:

   ```bash
   # Should return NIP-11 / relay info JSON (200), not "no community…"
   curl -sS "$BUZZ_RELAY_URL/" | head -c 200; echo

   export BUZZ_PRIVATE_KEY=nsec1...   # or load from your secret file
   buzz users get
   buzz channels list
   ```

4. Update `~/.agnt-server/.env` the same way and restart AGNT so the plugin’s child processes inherit it.

### What *not* to do

- Do **not** set `BUZZ_RELAY_URL=http://localhost:3000` just because Docker publishes port 3000, unless your relay truly maps `localhost` to a community (rare on compose/Tailscale installs).
- Do **not** assume `wss://` vs `https://` alone fixes a 404 community error — the **hostname** is what binds the community; use the public domain that humans open in the Buzz app.
- Do **not** point at the pairing relay path (`…/pair`) for normal channel tools.

### Verified pattern (self-hosted + Tailscale)

When Buzz is brought up via `deploy/compose` behind Caddy on a Tailscale (or other mesh) hostname:

1. `BUZZ_DOMAIN` / `RELAY_URL` in compose define the community host.
2. `BUZZ_RELAY_URL=https://$BUZZ_DOMAIN` for `buzz` CLI and this plugin.
3. `BUZZ_BIN` absolute path if LaunchAgent `PATH` lacks `~/.cargo/bin`.
4. `buzz users get` / plugin `buzz-whoami` return profile JSON; `buzz channels list` lists community channels.

If `https://$BUZZ_DOMAIN/` returns relay info but `http://127.0.0.1:3000/` returns “no community”, you have hit this quirk.

---

## Error handling

CLI exit codes are surfaced in tool `error` strings:

| Code | Meaning |
|------|---------|
| 0 | OK |
| 1 | User/input validation |
| 2 | Network / relay down **or** host not mapped to a community (see quirk above) |
| 3 | Auth (bad or missing key) |
| 4 | Other |
| 5 | Write conflict |

Stdout is parsed as JSON when possible; stderr JSON `{ "error", "message" }` is preferred for failures.

**Quick map of common setup failures:**

| Message / symptom | Fix |
|-------------------|-----|
| `BUZZ_PRIVATE_KEY is not set` | Add key to AGNT `.env` / env; restart backend |
| `Buzz CLI binary not found` | Install buzz-cli; set `BUZZ_BIN` to absolute path |
| `no community is configured for this host` | Use public `BUZZ_DOMAIN` HTTPS URL, not `localhost:3000` |
| Auth / exit 3 | Invalid `nsec` or key rejected by closed relay membership |

---

## Security notes

- Treat `BUZZ_PRIVATE_KEY` like a production bot token. Do not commit it, log it, or paste it into chat.
- Scope agents by **channel membership**, not by “superuser” keys.
- Prefer a dedicated sandbox workdir for agents that post diffs from local repos.
- Grok Build / AGNT may upload workspace context when coding; Buzz posts are separate signed events on your relay.

---

## Later: ACP + buzz-acp

For deeper first-class membership (long-lived agent sessions, richer tool loops inside Buzz), Block ships **`buzz-acp`** (ACP harness for Goose / Codex / Claude Code). That is a natural phase-2 upgrade. This CLI plugin remains the best portable v1 for Annie and any AGNT agent.

---

## Source layout

```
buzz-cli-plugin/
├── manifest.json          # tool schemas
├── package.json           # "type": "module", no npm deps
├── README.md
├── buzz-common.js         # spawn + JSON parse + env
├── buzz-send-message.js
├── buzz-get-messages.js
├── buzz-list-channels.js
├── buzz-join-channel.js
├── buzz-create-channel.js
├── buzz-get-thread.js
├── buzz-send-diff.js
└── buzz-whoami.js
```

## References

- [Buzz repository](https://github.com/block/buzz)
- [buzz-cli README](https://github.com/block/buzz/blob/main/crates/buzz-cli/README.md)
- [Introducing Buzz (Block)](https://block.xyz/inside/introducing-buzz-where-humans-and-agents-work-together)
- [buzz.xyz](https://buzz.xyz/)
