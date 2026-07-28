import { runBuzz, mergeParams, requireFields, successResult, errorResult } from './buzz-common.js';

/**
 * buzz-get-thread
 * Wrap: buzz messages thread --channel <uuid> --event <event-id>
 */
class BuzzGetThread {
  constructor() {
    this.name = 'buzz-get-thread';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const channel = p.channel || p.channelId;
      const event = p.event || p.eventId || p.messageId;
      const missing = requireFields({ channel, event }, ['channel', 'event']);
      if (missing) return errorResult(missing);

      const args = [
        'messages',
        'thread',
        '--channel',
        String(channel),
        '--event',
        String(event),
      ];

      const run = await runBuzz(args, { params: p });
      if (!run.success) {
        return errorResult(run.error, { exitCode: run.exitCode, stderr: run.stderr });
      }

      return successResult(run.data, {
        channel,
        event,
        exitCode: run.exitCode,
      });
    } catch (error) {
      console.error('[buzz-get-thread]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzGetThread();
