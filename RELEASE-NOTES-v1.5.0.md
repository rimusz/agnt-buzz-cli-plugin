# buzz-cli-plugin v1.5.0

**If you run the listener companion and anyone talks to your agent from the Buzz
phone app, please upgrade — those messages were being silently dropped.**

## The short version

Messages sent from the Buzz **phone** app were never seen by the agent. Not
delayed, not failed — never delivered to it at all. The message was stored by the
relay and visible to every human in the channel, so from the sender's side it
looked like the agent was simply ignoring them.

Desktop worked fine the whole time, which made it look like a flaky bot rather
than a structural gap.

The base `buzz-*` tools are unaffected. This is the opt-in listener only.

## What actually happened

The relay is **`#p`-gated**. A subscription can only ever receive events tagged
to the agent's pubkey — an un-p-gated `{kinds:[9]}` REQ is rejected outright:

```
restricted: p-gated events require #p matching your pubkey
```

That is fine, *provided every client attaches the tag*. The phone client does
not. Three consecutive messages in the same 1:1 DM, from the relay's own
database:

```
15:14:28 | hey Annie                          | tags: h, p:a87934c6…  -> replied in 6s
15:15:15 | hey Annie, i'm trying from phone   | tags: h               -> NEVER SEEN
15:15:42 | hey                                | tags: h, p:a87934c6…  -> replied in 4s
```

The middle message is not malformed. It carries no `p` tag because the phone
client does not add one — and it does not add one whether you type the agent's
name, pick it from autocomplete, or use reply. There was **no client-side
workaround**.

Two things made this hard to spot:

**1. `handler.js` had plain-text name matching that could never run.** It
supports a `name-mention` trigger, so `hey Annie, i'm trying from phone` *should*
have matched. But mention detection happens after delivery, and the event was
never delivered — the branch was unreachable dead code for exactly the messages
that needed it.

**2. The symptom was intermittent by client, not by time.** 25 of 97 messages
over 14 days had no `#p` tag. Anyone testing from a desktop saw a perfectly
healthy agent.

## The fix

`buzz messages get` — the HTTP API, authenticated as a channel member — is **not**
p-gated. So the listener now runs a second, complementary source:

| Source | Sees | Latency |
|---|---|---|
| `subscribe.js` (relay REQ) | messages **with** `#p:<agent>` | ~3s |
| `blindspot.js` (HTTP scan) | messages **without** `#p:<agent>` | ~3s |

Both feed the same `handler.ingest()`, so dedupe, debounce, threading and context
are unchanged.

**Double replies are impossible by construction.** The two sets are defined by
the presence and absence of the same tag; a message cannot be in both. This is a
structural guarantee, not a heuristic — no "did the other one already answer
this?" bookkeeping, and no race. `handler.js` still dedupes on event id anyway.

Measured on the deployment where this was found: **6 seconds** end to end from
phone send to reply posted.

## Also fixed: the agent stopped using people's names

The listener resolves display names from `authorAliases`, which was undocumented
and therefore usually empty — so it logged and prompted with `user:fc12db5f` and
the LLM had no name to use. `authorAliases` is now a first-class config key:

```json
"authorAliases": { "fc12db5f…": "Rimas" }
```

## Behaviour change worth knowing

**`requireMention` no longer applies inside a 1:1 DM room.**

It exists to stop an agent answering ambient chatter in a busy channel. In a 1:1
room there is no ambient chatter — every message is addressed to the agent. With
strict enforcement a bare `i'm good too` matched no mention and was dropped,
which is the same silent-drop symptom this release exists to fix.

Group-room behaviour is unchanged.

## Upgrading

```sh
# from the installed plugin's listener/ folder
./install-listener.sh          # re-run it; blindspot.js is a new file
```

Existing `config.json` files keep working — every new key has a default:

| Key | Default | |
|---|---|---|
| `blindspotEnabled` | `true` | set `false` only if a separate poller covers this |
| `blindspotIntervalMs` | `pollIntervalMs` (3000) | scan cadence |
| `lookbackMessages` | `20` | messages fetched per channel per scan |
| `authorAliases` | `{}` | `{ "<pubkeyHex>": "Name" }` |

On startup you should see:

```
blindspot: scanning every 3000ms (lookback=20, replyMode=dms_only, seeded=true)
```

The scanner **seeds silently on first run** — a fresh install marks existing
history as seen and answers none of it. After downtime it replies to the newest
unhandled message only, so a restart cannot fire a burst of late replies.

## Tests

`listener/blindspot.test.mjs` — 30 assertions, fully hermetic (no network, relay
or credentials; the `buzz` CLI is replaced by a fixture-serving fake).

It is verified to **fail** against the pre-fix `handler.js` (3 failures) and
against a `blindspot.js` with the `#p` filter removed (2 failures). A test that
cannot go red proves nothing — the same principle as `ops/test/negative-test.sh`
in v1.4.8.

## Known issue (pre-existing, not introduced here)

`listener/p1-test.mjs` has one failing assertion, `goal desc has buzz-send-message
tool`. It is present in v1.4.9 and earlier: the generated Goal description never
names the tool the agent should use to post its answer back. Unrelated to this
release and left alone deliberately — fixing it changes Goal-mode behaviour and
deserves its own change.
