# Buzz + AGNT setup checklist

**New install?** Start with **[CONNECT-ANY-AGENT.md](./CONNECT-ANY-AGENT.md)** (connect any agent to local or remote relay).

Use this denser list when bringing up a **new machine**, pointing at a **new relay**, or recovering after an upgrade.

---

## 0. Choose topology

- [ ] Relay **same host** as AGNT, or **remote**?
- [ ] Write down the browser URL that opens Buzz successfully:  
      `BUZZ_RELAY_URL=_______________________________`

If the UI only works via Tailscale/HTTPS hostname, **do not** use `http://localhost:3000` for agents.

---

## 1. Buzz CLI on the AGNT host

Resolution order: **`BUZZ_BIN` → PATH → fallbacks** (see [ARCHITECTURE.md § CLI binary resolution](./ARCHITECTURE.md#cli-binary-resolution-buzz)).

- [ ] `buzz` installed (`cargo install --path crates/buzz-cli` or prebuilt)
- [ ] Prefer **absolute** `BUZZ_BIN=/path/to/buzz` in AGNT `.env` (required for LaunchAgent)
- [ ] Or ensure `buzz` is on `PATH` for interactive use (`export PATH="$HOME/.cargo/bin:$PATH"`)
- [ ] Discover must not require `which buzz` alone — check `$BUZZ_BIN` and common paths
- [ ] `"$BUZZ_BIN" --help` or `buzz --help` works

---

## 2. Per-agent identity (required)

- [ ] Create or pick AGNT agent → copy **agentId** UUID
- [ ] Run `scripts/provision-agent-identity.js --agent-id <uuid> --name "Bot"`
- [ ] Key lands in `~/.agnt/buzz-identities/keys/<agentId>.key` (not shared env)
- [ ] Record pubkey / npub for invites (`provision … --list`)
- [ ] See [PER-AGENT-IDENTITY.md](./PER-AGENT-IDENTITY.md)

---

## 3. Relay membership (closed / private communities)

On the **Buzz relay host** (compose), not only on AGNT:

```bash
cd ~/.buzz/deploy/compose
./run.sh add-member <agent-pubkey-hex-or-npub>
./run.sh list-members
```

- [ ] Pubkey/npub from provision appears in `list-members`
- [ ] Then channel: bot `channels join` or owner `channels add-member --role bot`
- [ ] Open communities may skip `run.sh add-member`
- [ ] When adding many members: `sleep 1` between calls


## 4. AGNT plugin

- [ ] `buzz-cli-plugin` built and installed (or load from dev folder)
- [ ] Backend reload / restart so tools register
- [ ] Tools visible: whoami, list/join channels, get/send messages, thread, diff, create

```bash
cd ~/.agnt-server/backend/plugins
node cli/build-plugin.js buzz-cli-plugin
# install-file + /api/plugins/reload as per AGNT plugin docs
```

---

## 5. AGNT environment

Edit `~/.agnt-server/.env`:

```bash
# Do NOT set BUZZ_PRIVATE_KEY (per-agent registry instead)
BUZZ_RELAY_URL=https://your-host   # browser URL from AGNT host; can be remote
BUZZ_BIN=/Users/YOU/.cargo/bin/buzz
```

- [ ] Sync `backend/.env` if your process reads it
- [ ] Restart backend:  
      `launchctl kickstart -k "gui/$(id -u)/ai.agnt.backend"`
- [ ] Smoke: run tool **buzz-whoami** from AGNT or:

```bash
# same env as backend child
buzz users get
```

---

## 6. Assign tools to the AGNT agent

- [ ] Agent has all `buzz_*` tools (restricted mode recommended)
- [ ] Prefer API chat brain (e.g. GrokAI) for multi-tool turns
- [ ] Test: **Agents → that agent** → “whoami and list channels”
- [ ] Do not test only in bare orchestrator chat (no agentId)

---

## 7. Always-on DM replies (optional)

- [ ] `~/.agnt/annie-buzz-poller/` installed
- [ ] `agnt.token` present (JWT, mode 600)
- [ ] `config.json` `relayUrl` matches `BUZZ_RELAY_URL`
- [ ] LaunchAgent `com.agnt.annie-buzz-poller` loaded
- [ ] `node poller.js --once` seeds then replies to new DMs
- [ ] Send a DM from human account → Annie replies ≤ ~60s

```bash
node ~/.agnt/annie-buzz-poller/poller.js --status
tail -f ~/.agnt/annie-buzz-poller/poller.log
```

---

## 8. Regression tests

| Test | Pass criteria |
|------|----------------|
| CLI whoami | exit 0, display name Annie |
| CLI send to general | `accepted: true`, event id |
| CLI get messages | includes new event |
| Plugin whoami | `success: true` |
| DM poller | new human DM → Annie reply |
| Wrong URL `localhost` (compose) | fails with host/community error (documents quirk) |

---

## Troubleshooting quick map

| Symptom | Likely cause | Fix |
|---------|--------------|-----|
| `no community is configured for this host` | Host header ≠ community domain | Use public `BUZZ_DOMAIN` / UI URL |
| `BUZZ_PRIVATE_KEY is not set` | Backend env missing | `.env` + restart |
| `binary not found` | PATH / LaunchAgent | Set `BUZZ_BIN` absolute (order: BUZZ_BIN → PATH → fallbacks) |
| Plugin works, DMs unanswered | No poller | Install annie-buzz-poller |
| Poller auth errors | Expired `agnt.token` | Refresh JWT |
| Chat hangs 15 min | Grok-Build as chat brain | Switch to GrokAI |
| Remote relay timeout | Network / Tailscale | `curl` from AGNT host; check ACL |

---

## This machine (reference snapshot)

Filled in for the original lab install — **replace when documenting another host**.

| Item | Value |
|------|--------|
| Topology | Same host + Tailscale public hostname |
| Relay | `https://relay.example.com` |
| CLI | `/Users/tom/.cargo/bin/buzz` |
| Annie nsec | `~/.buzz/annie.nsec` |
| Plugin | `buzz-cli-plugin` in AGNT plugins |
| Poller | `~/.agnt/annie-buzz-poller` + LaunchAgent |
| AGNT branch note | Grok-Build connector on `local/grok-build-cli` (unrelated but often co-installed) |
