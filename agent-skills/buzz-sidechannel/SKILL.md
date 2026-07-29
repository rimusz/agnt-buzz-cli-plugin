---
name: buzz-sidechannel
description: "Use this skill when a Buzz request needs substantial, messy, or noisy work (multi-step research, a build, a long diff, lots of intermediate output) that you don't want to dump into the original thread. It encodes a clean closed loop: create a temporary side-channel with buzz-create-channel, do the work there (buzz-send-message / buzz-send-diff), then summarize back to the ORIGINAL thread with buzz-send-message using replyTo set to the triggering event id, and leave a cleanup marker. Trigger when a Buzz task will produce a lot of intermediate messages, when iterating on code/diffs that would clutter the main channel, or when a Goal tells you to 'create a side-channel to work in, then post a summary back'."
---

# Buzz Side-Channel (closed loop)

For **substantial or noisy** Buzz work, don't clutter the original thread. Create a
temporary side-channel, do the work there, then **summarize back** to the source
thread with `replyTo`. Keeps the main conversation tidy while preserving a full trail.

## When to use
- The request will generate many intermediate messages.
- You're iterating on code/diffs and want scratch space.
- A Goal instructs you to "create a side-channel, then post a summary back."

If the answer is short, just reply directly with `buzz-send-message` (replyTo=…) — no side-channel needed.

## The loop
Given `originalChannelId`, `originalEventId`, and a short `topic`:

1. **Open a side-channel** — `buzz-create-channel { name: "work-<topic>-<id>", description: "work for <original thread>" }`. Keep the returned channelId as `sideChannelId`.
2. **Do the work there** — post steps/notes with `buzz-send-message { channel: sideChannelId, content }`; post code with `buzz-send-diff { channel: sideChannelId, ... }`; read results with `buzz-get-messages { channel: sideChannelId }`.
3. **Summarize back to the ORIGINAL thread** — `buzz-send-message { channel: originalChannelId, replyTo: originalEventId, content: "<concise summary + outcome. Link the side-channel if useful.>" }`. **This is the important step** — always set `replyTo` so the answer threads correctly in the source conversation.
4. **Clean up** — post a final "done — archived" note in the side-channel (Buzz has no CLI hard-delete for channels; a clearly-named low-traffic side-channel is fine to leave as the work log).

## Rules
- The summary must be **self-contained** — the requester shouldn't need to open the side-channel to get the answer.
- Never post private keys or raw reasoning — post final artifacts + a summary.
- Always `replyTo` the original event id on the summary-back step.

## Related
- `buzz-teammate` skill — general Buzz teammate behavior (reply in-thread, escalate to Goals).
- Helper module (for programmatic use): the plugin ships `listener/sidechannel.js` (SideChannel class: open/post/postDiff/summarizeBack/close).
