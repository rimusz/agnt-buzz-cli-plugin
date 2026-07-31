# Changelog

## [1.4.3] - 2026-07-31

### Fixed
- **Goal-path replies now post back reliably (no more 4-minute stalls).** The
  autonomous "goal" reply path (deep research/analysis, then reply in the Buzz
  thread) could finish the actual work but never post the answer. Two causes,
  both fixed:
  1. The goal description instructed the agent to reply itself via
     `buzz-send-message`. The planner turned this into a separate "Reply in Buzz"
     task that ran agent-side, where the sandbox lacks working Buzz credentials —
     so it hung indefinitely. The description now states plainly that the LISTENER
     owns the post-back (it has working relay creds, same path as the ack); the
     agent just produces a clear final answer. Task graph drops from 3 tasks to 2
     (research + draft).
  2. The listener only posted back once ALL tasks were terminal — so a stuck
     agent-side reply task blocked the whole post-back until the 4-min poll
     deadline expired. Post-back now fires as soon as the first SUBSTANTIVE task
     completes with usable output (`substantiveDone`), extracting the answer and
     posting it immediately. Verified live end-to-end: answer posted in ~100s with
     the correct `replyTo`.


## [1.4.2] - 2026-07-31

### Fixed
- **Listener no longer crashes on transient relay/WebSocket blips.** `RelaySocket`
  emits an `error` event on a failed WebSocket handshake or dropped connection,
  but `index.js` never attached an `error` listener -- so Node threw on the
  unhandled `'error'` emission and killed the whole process. A single relay
  hiccup (e.g. a brief Tailscale/network blip) would take the listener down;
  launchd restarted it, but with a downtime window and a stale non-zero exit
  code, and a longer outage caused a crash loop. Added a non-fatal `socket.on(
  'error')` handler plus process-level `unhandledRejection` / `uncaughtException`
  guards. Transient errors are now logged and ridden through by the existing
  exponential-backoff reconnect; a genuine sustained outage still surfaces via
  `giveup` (clean `process.exit(1)` for the supervisor to restart).


## [1.4.1] - 2026-07-29

### Fixed
- **Autonomous goal replies no longer stall under load.** The listener's calls to
  the AGNT backend (goal poll / create) used a 20s abort timeout that could fire
  during busy goal execution, causing the answer to never post back (request
  acknowledged, then silence). Timeout raised to 45s, and abort/network errors in
  the poll loop are now treated as transient with a bounded consecutive-failure
  counter (gives up gracefully only after 8 straight failures instead of
  looping silently to the 4-min deadline).

### Changed
- goal-creator.js emits step-by-step logging (step[create] -> step[created] ->
  step[launch] -> step[poll cycle N status/tasks] -> step[extract] -> step[posted])
  for full observability of the goal reply path.
- config.template.json ships goalProvider="GrokAI"/goalModel="grok-4.5" as a
  belt-and-suspenders default so goals don't inherit a usage-capped provider.


## [1.5.0] - 2026-07-29

### Added
- **New tool `buzz-check-membership`** — check whether the agent is a member of a
  channel, or list membership status across all channels.
- **Identity rotation** — `buzz-provision-identity` now supports `rotate:true`:
  safely archives the old key and generates a fresh keypair for an existing agent
  (new pubkey must be re-added to closed relays). Provision results now surface both
  `npub` and `hexPubkey` explicitly, and attempt to set `bot:true` on the profile
  (ignored gracefully if the relay rejects it).
- **Identity status** — `buzz-list-identities` now reports per-identity status
  (`hasKey`, `provisioned`, `status`) plus an `okCount` / `needsAttention` summary.
- **Side-channel closed-loop helpers** — `listener/sidechannel.js` + skill
  `skills/buzz-sidechannel` make the "create side-channel → do work → summarize back
  to the thread with replyTo → clean up" pattern easy for agents.


## [1.4.0] - 2026-07-29

### Added
- **Listener → rich AGNT Goals (auto mode).** Incoming @mentions / #p-tagged
  messages can now create a fully-briefed AGNT Goal (title, full request, channel
  id+name, replyTo event id, thread root, author, timestamp, last 8-12 messages of
  context, and an explicit "reply in-thread via buzz-send-message with replyTo"
  instruction) and run it autonomously. New `listener/goal-creator.js`.
  `config.replyMode`: `auto` (default; quick streamed ack + background Goal for
  substantive requests) | `stream` | `goal`. Resilient: Goal creation retries with
  exponential backoff if the AGNT backend is temporarily down.
- **Mention detection.** Plain-text name/alias mentions (`agentName`/`agentAliases`,
  case-insensitive) are detected in addition to #p tags; the trigger method is
  logged and attached to the intent. `requireMention` gates ambient chatter.
- **New tool `buzz-search`** — full-text search across messages
  (`query` + optional `channel`/`author`/`since`/`limit`). Wraps `buzz messages search`.

### Changed
- **Structured, agent-friendly errors.** `buzz-common.js` now maps CLI exit codes
  to `{ errorCategory, hint, retryable }` and propagates them through every tool.
  Exit 2 (network) returns explicit BUZZ_RELAY_URL / public-hostname-vs-localhost /
  Host-header guidance.


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


