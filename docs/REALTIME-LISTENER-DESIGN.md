# Buzz Real-Time Listener — Design (Deliverable #1/#2)

> Replaces the 60s CLI poller with an **event-driven Nostr WebSocket listener**.
> Verified end-to-end against the live lab relay `wss://relay.example.com` on 2026-07-28.

---

## 1. What the relay actually supports (verified, not assumed)

Fetched the relay's **NIP-11** document (`GET /` with `Accept: application/nostr+json`):

```json
{
  "name": "Buzz Relay",
  "supported_nips": [1,2,10,11,16,17,23,25,29,33,38,42,50,56,43],
  "origin": "wss://relay.example.com",
  "push_kinds": [7,9,1059,40007,46010],
  "due_delivery_mode": "push",
  "limitation": { "auth_required": true, "restricted_writes": true,
                  "max_subscriptions": 1024, "max_filters": 10, "max_limit": 10000 }
}
```

Key facts this proves:

| NIP | Meaning for us |
|-----|----------------|
| **1** | Core Nostr: `REQ` / `EVENT` / `EOSE` / `CLOSE` over **WebSocket** — this *is* the subscribe transport. |
| **42** | **AUTH required** — must sign a kind-22242 challenge event before any subscription serves data. |
| **17** | Private DMs via gift-wrap (kind **1059**). |
| **29** | Relay-based groups/channels (Buzz channels). |
| 10/25/23/34 | Threads / reactions / long-form / git (already covered by the plugin tools). |

`due_delivery_mode: "push"` + `push_kinds:[7,9,1059,40007,46010]` = the relay is *built* to push these kinds. Kind **9** = chat message, **7** = reaction, **1059** = wrapped DM.

**The CLI has no `watch`/`subscribe`/`stream` command** (checked `messages`, `dms`, `feed`, `users`). So the listener must speak Nostr WebSocket directly — the CLI stays only for **sending** (`messages send`, which we already use and which handles NIP-OA signing correctly).

---

## 2. The handshake — verified working

Live run against the relay, using Annie's key (`~/.buzz/annie.nsec` → pubkey `a87934c6…0810179e`):

```
OPEN                                          ← wss upgrade succeeds
RECV ["AUTH","485c1dda…"]                      ← relay sends NIP-42 challenge on connect
SENT ["AUTH", <signed kind-22242 event>]       ← sign {relay, challenge} tags with schnorr
RECV ["OK","81ac83ed…",true,""]                ← AUTH ACCEPTED
SENT ["REQ","live",{"#p":[anniePk],"kinds":[9,7]}]
RECV ["EVENT",…] × N                            ← stored backlog (respecting `limit`)
RECV ["EOSE","live"]                            ← backlog done → now LIVE, every new event pushed
```

### Critical access-control rule discovered (the gotcha)

A blanket subscription `{"kinds":[9,1059]}` (no `#p`) is **rejected**:

```
["CLOSED","live","restricted: p-gated events require #p matching your pubkey"]
```

The relay is **p-gated**: an authenticated client may only stream events tagged to itself.
**Correct filter** — must include `#p: [ownPubkey]`:

```json
{ "#p": ["a87934c6…0810179e"], "kinds": [9, 7], "limit": 20 }
```

This was verified to replay real messages ("I want real time chat with agents via buzz", "any updates?") and then stay open for live delivery. ✅

> Implication: the listener naturally receives **only messages/replies/mentions/DMs directed at Annie** — exactly the poller's `dms_only` scope, but with **zero polling latency** and no per-channel cursor bookkeeping. Channel membership fan-out (all_channels mode) would need per-channel `#h` filters (channel id tag) added alongside `#p`.

---

## 3. Listener architecture

```
                    ┌─────────────────────────────────────────────┐
                    │  annie-buzz-listener  (LaunchAgent, always-on)│
                    └─────────────────────────────────────────────┘
   wss:// (persistent)          │
 ┌───────────────┐   AUTH+REQ   │   EVENT (push, ~0ms)
 │  Buzz Relay   │◄─────────────┤────────────────────────►  event handler
 │ (Nostr, NIP-42)│              │                              │
 └───────────────┘              │                     dedupe by event.id
        ▲                       │                     skip own pubkey
        │ messages send          │                     debounce per author (typing)
        │ (CLI, NIP-OA)          ▼                              │
        └──────────────  reply sender  ◄── streamed tokens ──  AGNT LLM (SSE)
```

### Modules

| Module | Responsibility |
|--------|----------------|
| `relay-socket.js` | Connect, NIP-42 auth (kind-22242 schnorr sign via `@noble/curves`), auto-reconnect w/ backoff, heartbeat/ping, re-auth on reconnect. |
| `subscribe.js` | Open `REQ` with the p-gated filter; treat `EOSE` as "backlog done"; hand each live `EVENT` to the handler. |
| `handler.js` | Dedupe (`Set` of seen `event.id`, LRU-capped), drop own-pubkey events, per-author debounce (collapse rapid msgs into one reply), enqueue. |
| `responder.js` | Call AGNT LLM. **Streaming path (#1):** consume the SSE token stream and edit a placeholder Buzz message as tokens arrive (see §4). |
| `state.js` | Persist last-seen `created_at` per author for crash recovery (replaces `state.json` cursors); a reconnect uses `since:` to backfill the gap. |

### Reconnect / resilience
- On socket close → exponential backoff (1s→2s→4s… cap 30s), full re-AUTH, re-`REQ`.
- On reconnect, filter adds `since: lastSeenCreatedAt - 5` to backfill any events missed while down (idempotent thanks to id-dedupe).
- Heartbeat: send an app-level `REQ` refresh or rely on ws ping; relay `max_subscriptions:1024` gives ample headroom.

---

## 4. Streaming replies (Deliverable #1)

Buzz has no token-stream wire type, **but** it has `messages edit` (edit a previously sent message by event id). That gives us a "typing/streaming" effect:

**Option A — Edit-stream (recommended, works today):**
1. On a new inbound message, immediately `messages send` a placeholder ("…") → get its event id.
2. Stream tokens from the AGNT LLM (SSE via `localhost:3333`).
3. Throttle-edit the placeholder every ~400ms / ~N tokens with the accumulated text via `messages edit`.
4. Final edit = full reply. Net effect in the Buzz UI: the message visibly fills in — real-time agent chat.

**Option B — Single deferred send (simplest):** stream server-side, send once when complete. Loses the visible typing effect but is trivial. Use as fallback if `messages edit` rate-limits.

> `restricted_writes: true` + `max_content_len` mean edits are cheap but should be throttled. Start with Option A at 400ms cadence; fall back to B on `OK false` write conflicts (exit 5).

---

## 5. Cutting the poller (Deliverable #2 — push/ack)

- The listener **is** the push mechanism — no 60s loop, no cursor scan.
- `state.json` per-channel cursors → replaced by a single `lastSeenCreatedAt` per author for gap-backfill on reconnect.
- Keep the poller as a **fallback / cold-standby**: if the listener's socket has been down > 2 min, a lightweight cron can do one catch-up poll. (Belt-and-suspenders during rollout.)
- Ack: Nostr `EVENT` delivery is the ack; our reply's `OK` from the relay confirms send. No separate ack channel needed.

### Rollout plan
1. Ship `annie-buzz-listener` alongside the poller; run both, but make the poller **read-only / no-send** (observe-only) for 24h to compare coverage.
2. Confirm listener replies match/beat poller on latency and completeness.
3. Flip poller to cold-standby (send disabled), listener owns sends.
4. Remove poller LaunchAgent once stable.

---

## 6. Dependencies & reuse

- **`@noble/curves` + `@noble/hashes`** — already vendored in `backend/node_modules` (used for the verified handshake). Listener can vendor or import these.
- **nsec decode** — 30-line bech32 decoder (verified: derives the correct pubkey `a87934c6…`). Or reuse the CLI's own key handling by keeping the key file path.
- **AGNT LLM** — same `localhost:3333` path the poller already uses (`generateReply`), swapped to the **streaming** endpoint for Option A.
- **Sending** — keep the existing `buzz messages send` / `messages edit` CLI calls (correct NIP-OA / auth-tag handling for free).

---

## 7. Open questions for Rimas / next spike

1. **Channel fan-out**: for `all_channels` mode, is per-channel `#h` (channel-id tag) the right filter, or is there a group-subscription (NIP-29) shortcut? (Need one channel id to test.)
2. **Edit-stream rate limits**: does the relay throttle rapid `messages edit` on one event id? (Test cadence 200/400/800ms.)
3. **APNs push profile**: `push.app_profiles` shows APNs for iOS — is there a webhook/HTTP push profile we could register for AGNT instead of holding a socket? (Socket is fine for an always-on Mac; webhook would suit serverless.)

---

*Status: design validated end-to-end against live relay. Ready to implement `relay-socket.js` + `subscribe.js` (the auth+subscribe core is already proven in code above).*


---

## 8. Edit-stream rate-limit test — RESULTS (verified 2026-07-28)

Ran real `buzz messages edit` bursts against a live DM channel (`9084741e…`).

**Cadence sweep (450ms → 150ms, inter-call sleep):** 10/10 edits `exit 0`, avg 60ms/call.
**Stress (50ms, back-to-back no-sleep, 100ms — 30 edits):** 30/30 `exit 0`, 0 failures, avg ~53ms/call.

**Total: 40+ edits, ZERO throttling / write-conflicts.** The relay is far more tolerant than assumed; the ~450ms cadence has large headroom (works down to back-to-back).

### How edits actually work (important implementation detail)
- `messages edit` does **not** mutate the original event. It publishes a **new event of kind `40003`** with:
  - an `h` tag = channel id
  - an `e` tag = original message event id
  - `content` = the new text
- `messages get` returns the **raw** original (unmerged), so a read-back shows the placeholder — this is expected and NOT a failure. Clients apply the latest `40003` for a given `e`-target.
- **Live subscribers DO receive the edit stream:** a `{"#h":[channel], kinds:[9,40003]}` (or `#p`-scoped) subscription received placeholder (kind-9) + all 8 edits (kind-40003) at clean ~510ms intervals → the message visibly fills in. **Verified PASS end-to-end.**

### Consequences for the code
- `responder.js` edit args are `--event <id> --content <text>` (NOT `--channel/--id`). **Fixed.**
- `editIntervalMs: 450` is safe with wide margin; could go lower for snappier typing. Keep 450 to be gentle and readable.
- `send` returns `{accepted, event_id, message}`; the placeholder's `event_id` is what every edit targets. Confirmed.
- No Option-B fallback needed for rate-limiting in practice, but it stays as a safety net for exit-5.
