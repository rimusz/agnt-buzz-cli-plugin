import { runBuzz, mergeParams, successResult, errorResult } from './buzz-common.js';

/**
 * buzz-list-channels
 * Wrap: buzz channels list
 */
class BuzzListChannels {
  constructor() {
    this.name = 'buzz-list-channels';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const run = await runBuzz(['channels', 'list'], { params: p });
      if (!run.success) {
        return errorResult(run.error, { exitCode: run.exitCode, stderr: run.stderr });
      }

      const channels = Array.isArray(run.data)
        ? run.data
        : run.data?.channels || run.data?.items || run.data;

      return successResult(channels, {
        count: Array.isArray(channels) ? channels.length : undefined,
        exitCode: run.exitCode,
      });
    } catch (error) {
      console.error('[buzz-list-channels]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzListChannels();
