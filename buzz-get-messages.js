import { runBuzz, mergeParams, requireFields, successResult, errorResult } from './buzz-common.js';

/**
 * buzz-get-messages
 * Wrap: buzz messages get --channel <uuid> [--limit N]
 */
class BuzzGetMessages {
  constructor() {
    this.name = 'buzz-get-messages';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const channel = p.channel || p.channelId;
      const missing = requireFields({ channel }, ['channel']);
      if (missing) return errorResult(missing);

      const limit = p.limit != null && p.limit !== '' ? Number(p.limit) : 20;
      const args = ['messages', 'get', '--channel', String(channel), '--limit', String(limit)];

      const run = await runBuzz(args, { params: p });
      if (!run.success) {
        return errorResult(run.error, { exitCode: run.exitCode, stderr: run.stderr });
      }

      const messages = Array.isArray(run.data)
        ? run.data
        : run.data?.messages || run.data?.items || run.data;

      return successResult(messages, {
        channel,
        limit,
        count: Array.isArray(messages) ? messages.length : undefined,
        exitCode: run.exitCode,
      });
    } catch (error) {
      console.error('[buzz-get-messages]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzGetMessages();
