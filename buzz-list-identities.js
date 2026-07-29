import { mergeParams, successResult, errorResult } from './buzz-common.js';
import { listPublicIdentities } from './buzz-keygen.js';

/**
 * buzz-list-identities
 *
 * List registered per-agent Buzz identities (public keys only).
 */
class BuzzListIdentities {
  constructor() {
    this.name = 'buzz-list-identities';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      mergeParams(params, inputData, workflowEngine); // context ok even if unused
      const data = listPublicIdentities();
      const attention =
        data.needsAttention && data.needsAttention.length
          ? ` ${data.needsAttention.length} need attention.`
          : '';
      return successResult(data, {
        message:
          `${data.count} Buzz identit${data.count === 1 ? 'y' : 'ies'} registered ` +
          `(${data.okCount} ok).${attention} Public keys only.`,
      });
    } catch (error) {
      console.error('[buzz-list-identities]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzListIdentities();
