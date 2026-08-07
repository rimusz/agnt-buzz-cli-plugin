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
3. **Scans for untagged messages** every ~3s over the Buzz HTTP API, because
   the relay refuses to deliver those over a subscription at all (see
   *How it scopes replies*). Without this, phone-sent messages are never seen.
4. For each new DM/mention: generates a reply via your AGNT backend and
   **edit-streams** it into Buzz so it visibly fills in.

Files: `index.js` (entry) · `relay-socket.js` (auth+reconnect) ·
`subscribe.js` (fast-poll) · `blindspot.js` (untagged-message scan) ·
`handler.js` (dedupe/debounce/context) ·
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

The relay is **p-gated**: a subscription only ever receives events tagged to
your agent's pubkey (`#p`). An un-p-gated `{kinds:[9]}` REQ is rejected outright
with `restricted: p-gated events require #p matching your pubkey`.

**Not every client attaches that tag.** The Buzz phone app sends plain kind-9
messages tagged only with the channel — even when you type the agent's name or
use reply. Those messages are stored by the relay and visible to every human in
the channel, but a subscription can never deliver them. Before v1.5.0 the agent
simply never saw them, which looked exactly like "the bot is down on mobile".

So the listener uses **two sources**:

| Source | Sees | Latency |
|---|---|---|
| `subscribe.js` (relay REQ) | messages **with** `#p:<agent>` | ~3s |
| `blindspot.js` (HTTP scan) | messages **without** `#p:<agent>` | ~3s |

The two sets are **disjoint by construction** — a message either carries the tag
or it does not — so the same message can never be answered twice. `handler.js`
also dedupes on event id as a second layer.

By default the scan covers **1:1 DM rooms only** (`replyMode: "dms_only"`); set
`replyMode: "all_channels"` to scan every channel. Set `blindspotEnabled: false`
to turn it off entirely — only sensible if a separate poller already covers it.

`requireMention: true` applies to group rooms. It is **deliberately not enforced
in a 1:1 DM**, where every message is addressed to the agent by definition and a
bare "thanks!" should still get a reply.

## Safety & behavior

- **Backlog guard:** on startup it won't re-answer old messages — only new ones.
  The blind-spot scanner seeds silently on first run, so a fresh install never
  answers channel history.
- **Dedupe + debounce:** never double-replies; collapses rapid bursts. After
  downtime the scanner replies to the **newest** unhandled message only and
  marks the rest seen, so a restart can't fire a burst.
- **Disjoint sources:** the relay subscription and the blind-spot scan handle
  mutually exclusive sets of messages — not a race that has to be de-duplicated.
- **Reasoning sanitizer:** strips any leaked model "thinking" and de-duplicates,
  so posted replies are clean.
- **Reconnect:** exponential backoff; the supervisor (LaunchAgent/systemd)
  relaunches on crash.

## Tuning

- `pollIntervalMs` — lower (e.g. 2000) for snappier, higher to ease relay load.
- `blindspotIntervalMs` — same trade-off for the untagged-message scan
  (defaults to `pollIntervalMs`). One scan is ~25ms of CLI time.
- `lookbackMessages` — how many recent messages each scan fetches (default 20).
- `authorAliases` — `{ "<pubkeyHex>": "Name" }` so the agent calls people by
  name instead of `user:fc12db5f`. This name is passed to the LLM, so leaving it
  empty is usually why an agent never uses anyone's name.
- `systemPrompt` — customize the agent's voice.

## Troubleshooting

| Symptom | Fix |
|---|---|
| No replies | Confirm AGNT backend is up (`localhost:3333`) and `agntTokenPath` is valid. |
| Replies on desktop but **not from the phone** | The phone client sends no `#p` tag. Confirm `blindspotEnabled` is not `false`, and look for `blindspot: scanning every …ms` at startup. |
| Agent never uses your name | Set `authorAliases` (`{"<pubkey>": "Name"}`) in `config.json`. |
| `could not load @noble` | Set `NOBLE_BASE` to an AGNT backend `node_modules` dir. |
| Auth rejected | Agent key not a relay member (closed relay) — add it on the relay host. |
| Replies but not to my DM | The message must be `#p`-tagged to the agent (Buzz app DMs/mentions are). |
