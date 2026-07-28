import { runBuzz, mergeParams, requireFields, successResult, errorResult } from './buzz-common.js';

/**
 * buzz-create-channel
 * Wrap: buzz channels create --name <name> [--type stream] [--visibility open]
 */
class BuzzCreateChannel {
  constructor() {
    this.name = 'buzz-create-channel';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const name = p.name || p.channelName;
      const missing = requireFields({ name }, ['name']);
      if (missing) return errorResult(missing);

      const type = p.channelType || p.type || 'stream';
      const visibility = p.visibility || 'open';

      const args = [
        'channels',
        'create',
        '--name',
        String(name),
        '--type',
        String(type),
        '--visibility',
        String(visibility),
      ];

      if (p.description) {
        args.push('--description', String(p.description));
      }

      const run = await runBuzz(args, { params: p });
      if (!run.success) {
        return errorResult(run.error, { exitCode: run.exitCode, stderr: run.stderr });
      }

      return successResult(run.data, {
        name,
        channelType: type,
        visibility,
        exitCode: run.exitCode,
      });
    } catch (error) {
      console.error('[buzz-create-channel]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzCreateChannel();
