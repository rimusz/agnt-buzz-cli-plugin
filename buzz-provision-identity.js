import { mergeParams, successResult, errorResult } from './buzz-common.js';
import { extractAgentId } from './buzz-identity.js';
import { provisionAgentIdentity, rotateAgentIdentity } from './buzz-keygen.js';

/**
 * buzz-provision-identity
 *
 * Generate, report, or ROTATE a Nostr identity for an AGNT agent.
 * Returns PUBLIC keys only (npub + hex) — never nsec / private key material.
 *
 * Modes:
 *   default        -> create if absent, else report existing (public info)
 *   rotate:true    -> archive the old key and generate a fresh keypair (safe
 *                     rotation). The NEW pubkey must be re-added to closed relays.
 *   overwrite:true -> replace the key in place (advanced; prefer rotate).
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
          'agentId is required (AGNT agent UUID to bind). Create the agent first, then pass its id.',
          { errorCategory: 'user_input' }
        );
      }

      const rotate = p.rotate === true || p.rotate === 'true';

      // Rotation only needs agentId; name/displayName optional (reuse existing).
      if (!rotate && !name) {
        return errorResult('name is required (display name for the Buzz identity).', {
          errorCategory: 'user_input',
        });
      }

      let result;
      if (rotate) {
        result = rotateAgentIdentity({
          agentId: String(agentId).trim(),
          name: name ? String(name).trim() : undefined,
          displayName: p.displayName ? String(p.displayName).trim() : undefined,
          relayUrl: p.relayUrl || p.buzzRelayUrl || undefined,
          inviteGeneral: p.inviteGeneral === true || p.inviteGeneral === 'true',
        });
      } else {
        result = provisionAgentIdentity({
          agentId: String(agentId).trim(),
          name: String(name).trim(),
          displayName: p.displayName ? String(p.displayName).trim() : undefined,
          relayUrl: p.relayUrl || p.buzzRelayUrl || undefined,
          inviteGeneral: p.inviteGeneral === true || p.inviteGeneral === 'true',
          overwrite: p.overwrite === true || p.overwrite === 'true',
          reuseKeyPath: p.reuseKeyPath || p.reuseKey || undefined,
        });
      }

      // Defense in depth: strip any accidental private fields.
      // Always surface BOTH npub and hex pubkey explicitly.
      const publicOnly = {
        success: true,
        created: result.created,
        alreadyExists: result.alreadyExists,
        rotated: result.rotated || false,
        agentId: result.agentId,
        agentName: result.agentName,
        displayName: result.displayName,
        npub: result.npub || null,
        hexPubkey: result.pubkeyHex || null,
        pubkeyHex: result.pubkeyHex || null, // back-compat alias
        botFlagged: result.botFlagged || false,
        relayUrl: result.relayUrl,
        keyPath: result.keyPath,
        archivedKey: result.archivedKey || null,
        identityCard: result.identityCard || null,
        generalJoin: result.generalJoin || null,
        note: result.note,
        // never: privateKey, nsec, privHex
      };

      const keys = `npub=${result.npub || 'n/a'} hex=${result.pubkeyHex || 'n/a'}`;
      const message = result.rotated
        ? `Rotated Buzz identity for ${result.displayName}. NEW ${keys}. Re-add the new pubkey to closed relays.`
        : result.created
        ? `Created Buzz identity for ${result.displayName}. ${keys}`
        : `Identity already exists for ${result.displayName}. ${keys}`;

      return successResult(publicOnly, { message });
    } catch (error) {
      console.error('[buzz-provision-identity]', error);
      return errorResult(error);
    }
  }
}

export default new BuzzProvisionIdentity();
