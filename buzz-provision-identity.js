import { mergeParams, successResult, errorResult } from './buzz-common.js';
import { extractAgentId } from './buzz-identity.js';
import { provisionAgentIdentity } from './buzz-keygen.js';

/**
 * buzz-provision-identity
 *
 * Generate (or report) a Nostr identity for an AGNT agent.
 * Returns PUBLIC keys only — never nsec / private key material.
 */
class BuzzProvisionIdentity {
  constructor() {
    this.name = 'buzz-provision-identity';
  }

  async execute(params, inputData, workflowEngine) {
    try {
      const p = mergeParams(params, inputData, workflowEngine);
      const agentId =
        p.agentId ||
        p.targetAgentId ||
        extractAgentId(p, inputData, workflowEngine);
      const name = p.name || p.agentName || p.displayName;

      if (!agentId) {
        return errorResult(
          'agentId is required (AGNT agent UUID to bind). Create the agent first, then pass its id.'
        );
      }
      if (!name) {
        return errorResult('name is required (display name for the Buzz identity).');
      }

      const result = provisionAgentIdentity({
        agentId: String(agentId).trim(),
        name: String(name).trim(),
        displayName: p.displayName ? String(p.displayName).trim() : undefined,
        relayUrl: p.relayUrl || p.buzzRelayUrl || undefined,
        inviteGeneral: p.inviteGeneral === true || p.inviteGeneral === 'true',
        overwrite: p.overwrite === true || p.overwrite === 'true',
        reuseKeyPath: p.reuseKeyPath || p.reuseKey || undefined,
      });

      // Defense in depth: strip any accidental private fields
      const publicOnly = {
        success: true,
        created: result.created,
        alreadyExists: result.alreadyExists,
        agentId: result.agentId,
        agentName: result.agentName,
        displayName: result.displayName,
        pubkeyHex: result.pubkeyHex,
        npub: result.npub,
        relayUrl: result.relayUrl,
        keyPath: result.keyPath,
        identityCard: result.identityCard || null,
        generalJoin: result.generalJoin || null,
        note: result.note,
        // never: privateKey, nsec, privHex
      };

      return successResult(publicOnly, {
        message: result.created
          ? `Created Buzz identity for ${result.displayName}. Public key: ${result.npub || result.pubkeyHex}`
          : `Identity already exists for ${result.displayName}. Public key: ${result.npub || result.pubkeyHex}`,
      });
    } catch (error) {
      console.error('[buzz-provision-identity]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzProvisionIdentity();
