import { runBuzz, mergeParams, successResult, errorResult } from './buzz-common.js';

/**
 * buzz-check-membership
 *
 * Check whether the current agent identity is a member of a given channel, or
 * list membership status across all channels.
 *
 * Buzz's `channels list` returns the channels the current identity can see /
 * has joined, so we use it as the source of truth for "am I a member?".
 *
 * Usage:
 *   { channel: "<uuid>" }  -> { channelId, isMember, channelName }
 *   { }                    -> { channels: [{channelId,name,isMember}], memberCount, totalChannels }
 *
 * Optional filter: pass allChannels:true to always return the full status map
 * even when a channel is given.
 */
class BuzzCheckMembership {
  constructor() {
    this.name = 'buzz-check-membership';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const channel = p.channel || p.channelId;
      const wantAll = p.allChannels === true || p.allChannels === 'true' || !channel;

      const run = await runBuzz(['channels', 'list'], { params: p });
      if (!run.success) {
        return errorResult(run.error, { exitCode: run.exitCode, stderr: run.stderr });
      }

      const list = Array.isArray(run.data)
        ? run.data
        : run.data?.channels || run.data?.items || run.data || [];

      const norm = (Array.isArray(list) ? list : []).map((c) => ({
        channelId: c.channel_id || c.id,
        name: c.name || null,
        // channels list = channels the identity is a member of / can see
        isMember: true,
      }));
      const memberIds = new Set(norm.map((c) => c.channelId));

      // Single-channel check
      if (channel && !wantAll) {
        const hit = norm.find((c) => c.channelId === channel);
        return successResult(
          {
            channelId: channel,
            isMember: memberIds.has(channel),
            channelName: hit?.name || null,
          },
          {
            message: memberIds.has(channel)
              ? `Agent IS a member of channel ${hit?.name ? '#' + hit.name : channel}.`
              : `Agent is NOT a member of channel ${channel} (join it with buzz-join-channel).`,
            exitCode: run.exitCode,
          }
        );
      }

      // Full status map (all visible/member channels). If a specific channel was
      // asked for alongside allChannels, flag it explicitly too.
      const result = {
        channels: norm,
        memberCount: norm.length,
        totalChannels: norm.length,
      };
      if (channel) {
        result.queriedChannel = { channelId: channel, isMember: memberIds.has(channel) };
      }

      return successResult(result, {
        message: `Agent is a member of ${norm.length} channel${norm.length === 1 ? '' : 's'}.`,
        exitCode: run.exitCode,
      });
    } catch (error) {
      console.error('[buzz-check-membership]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzCheckMembership();
