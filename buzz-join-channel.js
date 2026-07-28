import { runBuzz, mergeParams, requireFields, successResult, errorResult } from './buzz-common.js';

/**
 * buzz-join-channel
 * Wrap: buzz channels join --channel <uuid>
 */
class BuzzJoinChannel {
  constructor() {
    this.name = 'buzz-join-channel';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const channel = p.channel || p.channelId;
      const missing = requireFields({ channel }, ['channel']);
      if (missing) return errorResult(missing);

      const run = await runBuzz(['channels', 'join', '--channel', String(channel)], { params: p });
      if (!run.success) {
        return errorResult(run.error, { exitCode: run.exitCode, stderr: run.stderr });
      }

      return successResult(run.data, { channel, exitCode: run.exitCode });
    } catch (error) {
      console.error('[buzz-join-channel]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzJoinChannel();
