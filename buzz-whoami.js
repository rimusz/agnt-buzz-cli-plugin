import { runBuzz, mergeParams, successResult, errorResult } from './buzz-common.js';

/**
 * buzz-whoami
 * Wrap: buzz users get  (own profile for the configured private key)
 */
class BuzzWhoami {
  constructor() {
    this.name = 'buzz-whoami';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const args = ['users', 'get'];
      if (p.pubkey) {
        args.push('--pubkey', String(p.pubkey));
      }

      const run = await runBuzz(args, { params: p });
      if (!run.success) {
        return errorResult(run.error, { exitCode: run.exitCode, stderr: run.stderr });
      }

      return successResult(run.data, { exitCode: run.exitCode });
    } catch (error) {
      console.error('[buzz-whoami]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzWhoami();
