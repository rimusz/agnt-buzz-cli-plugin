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
      return successResult(data, {
        message: `${data.count} Buzz identit${data.count === 1 ? 'y' : 'ies'} registered (public keys only).`,
      });
    } catch (error) {
      console.error('[buzz-list-identities]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzListIdentities();
