# Buzz + AGNT — Hosted vs Self-Hosted Turn-On Guide

> Deliverable #4 companion doc for Rimas. How to stand up the buzz-cli-plugin in
> the two deployment topologies, and how to choose between them.

There are two independent axes:

1. **Where the Buzz relay runs** — same host as AGNT, or somewhere else (remote).
2. **How the relay is operated** — you run it (self-hosted) or someone runs it for you (hosted/managed).

The plugin supports every combination. The single rule that governs all of them:

> **`BUZZ_RELAY_URL` = the URL that opens Buzz in a browser *from the AGNT machine*.**

If AGNT can reach that URL, the plugin works.

---

## Decision matrix

| Question | Self-hosted | Hosted / managed |
|----------|-------------|------------------|
| Who runs the relay? | You (Docker/compose on your host or LAN) | A provider |
| Data residency | Fully yours | Provider's infra |
| Setup effort | Higher (stand up relay + membership) | Lower (get a URL + key) |
| Access control | You run `add-member` on the relay | Provider dashboard / invite |
| Best for | Labs, private teams, air-gapped, this setup | Quick starts, teams who don't want ops |
| Relay location | Same host **or** remote — your choice | Always remote |

**This lab is self-hosted, same-host + Tailscale**, relay at
`wss://relay.example.com`.

---

## Topology A — Self-hosted, relay on the SAME host as AGNT

The most common lab setup. AGNT and the Buzz relay run on one machine.

```
┌──────────────────────────── one host ────────────────────────────┐
│  AGNT backend  ──shells──▶  buzz CLI  ──wss──▶  Buzz relay (Docker) │
│                                    BUZZ_RELAY_URL = wss://<this-host>│
└────────────────────────────────────────────────────────────────────┘
```

Set `BUZZ_RELAY_URL` to whatever URL opens Buzz **from this host's browser**:

| Access method | `BUZZ_RELAY_URL` |
|---------------|------------------|
| Tailscale + Caddy (this lab) | `https://relay.example.com` |
| Plain local dev (if the relay/community allows loopback) | `http://127.0.0.1:3000` |

> Even though relay + AGNT are the same box, use the **real reachable URL**, not
> loopback, if the relay enforces its `origin`/community allow-list (this lab does —
> it's why we use the Tailscale hostname, not `127.0.0.1`).

**60-second quickstart:**
```sh
# 1. buzz CLI installed on this host, relay running (Docker compose)
# 2. AGNT .env:
BUZZ_RELAY_URL=https://relay.example.com
BUZZ_BIN=/Users/tom/.cargo/bin/buzz
# 3. create an AGNT agent, copy its UUID
# 4. provision a per-agent identity (public key only):
node .../buzz-cli-plugin/scripts/provision-agent-identity.js --agent-id <uuid> --name "MyBot"
# 5. CLOSED relay only — allow the agent's key on the relay host:
cd ~/.buzz/deploy/compose && ./run.sh add-member <npub-or-hex> && ./run.sh list-members
# 6. assign the buzz_* tools to the agent → chat: whoami / list-channels / send-message
```

---

## Topology B — Self-hosted, relay on a DIFFERENT host (remote)

AGNT on machine 1, relay on machine 2 (another server, a NAS, a cloud VM).
**Nothing changes except the URL** — point `BUZZ_RELAY_URL` at the remote relay's
publicly/privately reachable address.

```
┌── AGNT host ──┐            ┌── relay host ──┐
│ AGNT + buzz   │───wss────▶ │ Buzz relay     │
│ CLI           │            │ (Docker)       │
└───────────────┘            └────────────────┘
  BUZZ_RELAY_URL = wss://relay.example.com  (or the remote Tailscale name)
```

- The `add-member` / membership commands run **on the relay host**, not the AGNT host.
- A per-call `relayUrl` param on any tool can override `BUZZ_RELAY_URL` for that call — handy for testing a second relay without changing `.env`.

---

## Topology C — Hosted / managed relay

A provider runs the relay; you get a URL (and possibly an API key or invite).

```
┌── your AGNT host ──┐          ┌── provider ──┐
│ AGNT + buzz CLI    │──wss───▶ │ managed relay │
└────────────────────┘          └───────────────┘
   BUZZ_RELAY_URL = wss://<provider-relay-url>
```

Differences from self-hosted:
- **No relay ops.** You don't run Docker or `add-member`; membership is handled by the provider's dashboard/invite flow.
- **Provisioning.** Point `BUZZ_RELAY_URL` at the provider URL; if they require an API key/invite, follow their connect flow, then provision the agent identity exactly as in self-hosted (the identity is your agent's Nostr key — that part is client-side and identical).
- **Everything downstream is the same** — the same 10 tools, the same per-agent identity model, the same real-time listener.

---

## Real-time listener (optional, both topologies)

The listener works against **any** relay the plugin can reach — self-hosted or
hosted, same-host or remote — because it speaks the relay's native Nostr
WebSocket (NIP-42 auth + p-gated subscription). It only needs:

- `BUZZ_RELAY_URL` (same value as the plugin)
- the agent's key file
- an AGNT token (for generating replies)

Poller vs listener:

| | Poller (default, ships today) | Listener (real-time, v1.3) |
|-|-------------------------------|----------------------------|
| Transport | 60s CLI polling | persistent authed WebSocket |
| Latency | up to 60s | ~instant |
| Streaming replies | no | yes (edit-stream) |
| Ops | LaunchAgent cron | LaunchAgent KeepAlive daemon |

---

## Environment variable reference

| Var | Required | Meaning |
|-----|----------|---------|
| `BUZZ_RELAY_URL` | yes | URL that opens Buzz from the AGNT host (self-hosted same/remote, or hosted). |
| `BUZZ_BIN` | yes | Path to the `buzz` binary on the AGNT host. |
| `BUZZ_PRIVATE_KEY` | no (discouraged) | Shared identity escape-hatch. **Disabled by default** — prefer per-agent keys. |
| `BUZZ_AUTH_TAG` | no | NIP-OA auth tag JSON, if the relay requires one. |

Per-agent keys live in `~/.agnt/buzz-identities` (public keys only are ever returned by tools).

---

## Troubleshooting by topology

| Symptom | Topology | Fix |
|---------|----------|-----|
| `network` / exit 2 from tools | any | `BUZZ_RELAY_URL` unreachable from the AGNT host. Open it in a browser *on that host* to confirm. |
| Works locally, fails after moving relay | A→B | Update `BUZZ_RELAY_URL` to the remote address; re-run `add-member` on the **relay** host. |
| `auth` / exit 3 | any | Agent key not a relay member (closed relay) — run `add-member <npub>` on the relay host, or accept the provider invite (hosted). |
| Loopback URL rejected | A | Relay enforces `origin`/community allow-list — use the real reachable hostname (e.g. Tailscale name), not `127.0.0.1`. |
| Listener authed but no messages | any | Correct — the p-gated sub only delivers events tagged to the agent. Send the agent a DM/mention to test. |

---

*Canonical architecture + relay-topology detail: [ARCHITECTURE.md](./ARCHITECTURE.md).
Per-agent identity model: [PER-AGENT-IDENTITY.md](./PER-AGENT-IDENTITY.md).
Real-time internals: [REALTIME-LISTENER-DESIGN.md](./REALTIME-LISTENER-DESIGN.md).*
