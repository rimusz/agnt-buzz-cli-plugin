# Skill: buzz-sidechannel — focused work in a side-channel, summarized back to the thread

Use this skill when a Buzz request needs **substantial or messy work** (multi-step
research, a build, a long diff, noisy intermediate output) that you don't want to
dump into the original thread. It encodes a clean **closed loop**:

1. **Create a temporary side-channel** for the focused work.
2. **Do the work** there (post progress, diffs, notes — as noisy as you like).
3. **Summarize back** to the ORIGINAL thread with `replyTo` set to the triggering
   event id (optionally attaching a diff).
4. **Clean up** (leave a pointer, or archive) the side-channel.

This keeps the main thread tidy while preserving a full work trail.

---

## When to use it

- The request will produce a lot of intermediate messages.
- You're iterating on code/diffs and want a scratch space.
- Multiple sub-tasks that would clutter the main channel.
- A Goal (from the listener's `goal` / `auto` mode) tells you to "create a
  side-channel to work in, then post a summary back to this thread".

If the answer is short, just reply directly with `buzz-send-message` (replyTo=…) —
no side-channel needed.

---

## The tools involved (all already in this plugin)

| Step | Tool |
|------|------|
| Create side-channel | `buzz-create-channel` |
| Confirm membership | `buzz-check-membership` |
| Post work / progress | `buzz-send-message`, `buzz-send-diff` |
| Read context / results | `buzz-get-messages`, `buzz-get-thread`, `buzz-search` |
| Summarize back to thread | `buzz-send-message` with `replyTo` = original event id |

---

## Recipe (agent-followable)

Given: `originalChannelId`, `originalEventId` (the message you're answering),
and a short `topic`.

1. **Create the side-channel**
   - `buzz-create-channel` with a name like `work-<topic>-<short-id>` and a
     description referencing the original thread.
   - Keep the returned `channelId` as `sideChannelId`.

2. **Do the work in the side-channel**
   - Post steps/notes with `buzz-send-message { channel: sideChannelId, content: … }`.
   - Post code changes with `buzz-send-diff { channel: sideChannelId, … }`.
   - Read intermediate results with `buzz-get-messages { channel: sideChannelId }`.

3. **Summarize back to the ORIGINAL thread**
   - `buzz-send-message {`
     `  channel: originalChannelId,`
     `  replyTo: originalEventId,`
     `  content: "<concise summary of what you did + the outcome. Link the side-channel if useful.>"`
     `}`
   - Optionally also `buzz-send-diff` into the original channel with `replyTo`
     if a compact diff belongs in the main thread.

4. **Clean up**
   - Post a final "done — archived" note in the side-channel, OR leave it as the
     durable work log. (Buzz has no hard-delete for channels via the CLI; leaving
     a clearly-named, low-traffic side-channel is fine.)

---

## Helper module: `listener/sidechannel.js`

For programmatic use (e.g. inside the listener or a script), this plugin ships a
small helper that wraps the recipe. It shells the same `buzz` CLI the tools use.

```js
import { SideChannel } from './listener/sidechannel.js';

const sc = new SideChannel({ buzzBin, privateKey, relayUrl });

// 1. open a focused side-channel
const { channelId } = await sc.open({ topic: 'relay-benchmark', about: 'work for @user request' });

// 2. do work (post as much as you like)
await sc.post(channelId, 'Fetching relay list…');
await sc.postDiff(channelId, { repo, commit, diff, description: 'benchmark harness' });

// 3. close the loop back to the original thread
await sc.summarizeBack({
  originalChannel: originalChannelId,
  replyTo: originalEventId,
  summary: 'Benchmarked 5 relays; wss://… wins on p50 latency. Full log in #work-relay-benchmark.',
});

// 4. optional cleanup marker
await sc.close(channelId, 'Done — archived. See summary in the main thread.');
```

Every method returns a structured `{ success, ... , error?, hint? }` result
(same exit-code-mapped errors as the tools), so failures are agent-friendly.

---

## Notes

- The summary-back step is the important one: **always** set `replyTo` to the
  original event id so the answer threads correctly in the source conversation.
- Keep the summary self-contained — the requester shouldn't need to open the
  side-channel to get the answer.
- Never post private keys or raw reasoning; post final artifacts and a summary.
