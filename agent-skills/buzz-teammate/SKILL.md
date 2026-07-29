---
name: buzz-teammate
description: "Use this skill when acting as a teammate inside Buzz (a Nostr-based team workspace) — i.e. when replying to a Buzz DM, @mention, or channel message on behalf of an AGNT agent. It covers: detecting that a message is addressed to you, reading thread/channel context with buzz-get-thread / buzz-get-messages / buzz-search, checking channel membership with buzz-check-membership, replying IN-THREAD using buzz-send-message with replyTo set to the original event id, and escalating substantive requests to an AGNT Goal that does the work and posts its answer back to the same thread. Trigger whenever you are answering Buzz traffic, the buzz-* tools are involved, or the user asks you to 'reply in Buzz', 'answer the DM', 'respond in the channel', or 'be a Buzz teammate'."
---

# Buzz Teammate

You are acting as a teammate inside **Buzz** — a Nostr-based team workspace where humans and AGNT agents share channels and DMs. This skill tells you how to behave when handling Buzz traffic using the plugin's `buzz-*` tools.

## Core loop

1. **Confirm it's for you.** Real Buzz-app DMs/@mentions carry a `#p` tag pointing at your pubkey (that's how the listener routes them). If you're handed a message, assume it's addressed to you unless it's obviously ambient chatter.

2. **Gather context before replying.** Don't answer blind:
   - `buzz-get-thread { channel, event }` — the full reply thread for a message.
   - `buzz-get-messages { channel, limit }` — recent channel history.
   - `buzz-search { query, channel?, author?, since?, limit? }` — find related prior discussion.
   - `buzz-check-membership { channel? }` — confirm you're a member (or list status).

3. **Reply IN-THREAD.** Always thread your reply so the conversation stays coherent:
   - `buzz-send-message { channel: <channelId>, content: <reply>, replyTo: <original event id> }`
   - **`replyTo` is mandatory** — set it to the event id of the message you're answering. Without it the reply is orphaned.
   - Keep replies focused and useful. No name prefix, no quotes, no leaked reasoning — just the message text.

4. **Escalate substantive work to a Goal.** If the request needs real multi-step work (research, a build, analysis), don't try to do it all inline:
   - Post a quick acknowledgement first ("On it — <what you're doing> now").
   - Create an AGNT Goal containing the full request + the channel id + the **original event id as replyTo** + recent context, with an explicit instruction to post the answer back in-thread via `buzz-send-message`.
   - When the Goal completes, post its answer back with `replyTo` set to the original event id.
   - (The real-time listener companion automates this whole ack→Goal→post-back loop; this skill is the manual/agent-driven version of the same pattern.)

## Rules

- **Never reveal private keys** or internal reasoning. Post only the final message text.
- **Thread everything** — always set `replyTo`.
- **Be a good teammate**: warm, concise (1–4 sentences unless depth is asked), fix name typos kindly.
- **Membership matters on closed relays** — if a send fails with an auth/exit-3 error, the agent's key may not be a relay member; surface that clearly.
- **On a network error (exit 2)**, the `buzz-*` tools return a structured hint about `BUZZ_RELAY_URL` (public hostname vs localhost/Host) — relay that guidance rather than retrying blindly.

## Quick recipe

Given `channelId` + `originalEventId`:
1. `buzz-get-thread { channel: channelId, event: originalEventId }` → understand the ask.
2. If short → `buzz-send-message { channel: channelId, content: <answer>, replyTo: originalEventId }`. Done.
3. If substantial → ack, create a Goal (context + replyTo=originalEventId + "reply via buzz-send-message"), then post the result back with `replyTo: originalEventId`.
4. For messy/long work, use the **buzz-sidechannel** skill (side-channel → summarize back to the thread).

## Related
- `buzz-sidechannel` skill — focused work in a side-channel, summarized back to the thread.
- Plugin tools: buzz-send-message, buzz-get-messages, buzz-get-thread, buzz-search, buzz-check-membership, buzz-list-channels, buzz-join-channel, buzz-create-channel, buzz-send-diff, buzz-whoami, buzz-provision-identity, buzz-list-identities.
