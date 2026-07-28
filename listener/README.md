# Buzz Real-Time Listener — opt-in companion

Makes your AGNT agent **auto-reply to Buzz DMs & mentions in ~3 seconds**, with a
live "typing" (streaming) effect — turning the agent into a real-time teammate
instead of something you invoke manually.

> **This is optional.** The plugin's `buzz-*` tools work fine without it (manual
> send/read from chat & workflows). Install this only if you want *autonomous*
> instant replies.

---

## What it is

A small always-on Node service that:
1. Holds one authenticated WebSocket to your Buzz relay (NIP-42).
2. **Fast-polls** every ~3s for messages tagged to your agent (`#p`).
   *(The Buzz relay uses a push/query model, not live streaming, so polling is
   the correct approach — it's still ~3s, vs a naive 60s loop.)*
3. For each new DM/mention: generates a reply via your AGNT backend and
   **edit-streams** it into Buzz so it visibly fills in.

Files: `index.js` (entry) · `relay-socket.js` (auth+reconnect) ·
`subscribe.js` (fast-poll) · `handler.js` (dedupe/debounce/context) ·
`responder.js` (streaming reply + reasoning-leak sanitizer) · `nostr.js` (crypto).

---

## Requirements (honest)

- An **always-on machine** — it's a local background service (LaunchAgent on
  macOS / systemd on Linux), not a hosted cloud service. It runs while your
  computer is up.
- A **running AGNT backend** at `localhost:3333` — the listener calls it to
  generate replies.
- The **`buzz` CLI** installed, and your agent's **Buzz identity provisioned**
  (`buzz-provision-identity`) and a **relay member** (closed relays).
- `node` 18+ and `@noble/curves` + `@noble/hashes` available (any AGNT backend
  ships them; the listener auto-locates them, or set `NOBLE_BASE`).

---

## Setup

```sh
# 1. from the installed plugin's listener/ folder:
cp config.template.json config.json
#    edit config.json — set relayUrl, nsecPath (your agent's key),
#    agntTokenPath (a file with your AGNT token), buzzBin, provider/model.

# 2. install + start (macOS LaunchAgent / Linux systemd):
./install-listener.sh

#    dry-run first (recommended): sends nothing, just logs what it *would* reply
./install-listener.sh --observe

# 3. watch it work:
tail -f listener.log
#    look for: "subscribe: fast-poll started", then "handler: intent" +
#    "responder: replied (streamed)" when a DM arrives.

# stop / remove:
./install-listener.sh --uninstall
```

`config.json` keys: `relayUrl` (the URL that opens Buzz from **this** machine),
`nsecPath`, `agntApi`, `agntTokenPath`, `buzzBin`, `llmProvider`, `llmModel`,
`pollIntervalMs` (default 3000), optional `systemPrompt` (override persona).
`~` and `$HOME` are expanded. You can also use env `BUZZ_PRIVATE_KEY` /
`AGNT_AUTH_TOKEN` instead of the file paths.

---

## How it scopes replies

The relay is **p-gated**: the listener only receives events tagged to your
agent's pubkey (`#p`). Real Buzz-app DMs and @mentions carry that tag, so the
agent replies exactly to messages addressed to it — not to every channel line.

## Safety & behavior

- **Backlog guard:** on startup it won't re-answer old messages — only new ones.
- **Dedupe + debounce:** never double-replies; collapses rapid bursts.
- **Reasoning sanitizer:** strips any leaked model "thinking" and de-duplicates,
  so posted replies are clean.
- **Reconnect:** exponential backoff; the supervisor (LaunchAgent/systemd)
  relaunches on crash.

## Tuning

- `pollIntervalMs` — lower (e.g. 2000) for snappier, higher to ease relay load.
- `systemPrompt` — customize the agent's voice.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No replies | Confirm AGNT backend is up (`localhost:3333`) and `agntTokenPath` is valid. |
| `could not load @noble` | Set `NOBLE_BASE` to an AGNT backend `node_modules` dir. |
| Auth rejected | Agent key not a relay member (closed relay) — add it on the relay host. |
| Replies but not to my DM | The message must be `#p`-tagged to the agent (Buzz app DMs/mentions are). |
