#!/usr/bin/env node
/**
 * CLI wrapper around buzz-keygen.provisionAgentIdentity
 * Does NOT print private keys.
 *
 *   node provision-agent-identity.js --agent-id <uuid> --name "Bot" [--invite-general]
 *   node provision-agent-identity.js --list
 */
import { provisionAgentIdentity, listPublicIdentities } from '../buzz-keygen.js';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--invite-general') out.inviteGeneral = true;
    else if (a === '--overwrite') out.overwrite = true;
    else if (a === '--agent-id') out.agentId = argv[++i];
    else if (a === '--name') out.name = argv[++i];
    else if (a === '--display-name') out.displayName = argv[++i];
    else if (a === '--relay') out.relayUrl = argv[++i];
    else if (a === '--reuse-key') out.reuseKeyPath = argv[++i];
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Usage:
  node provision-agent-identity.js --agent-id <uuid> --name "Bot" [--invite-general] [--relay URL]
  node provision-agent-identity.js --list
`);
  process.exit(0);
}

try {
  if (args.list) {
    console.log(JSON.stringify(listPublicIdentities(), null, 2));
    process.exit(0);
  }
  if (!args.agentId || !args.name) {
    console.error('Required: --agent-id and --name');
    process.exit(1);
  }
  const result = provisionAgentIdentity({
    agentId: args.agentId,
    name: args.name,
    displayName: args.displayName,
    relayUrl: args.relayUrl,
    inviteGeneral: args.inviteGeneral,
    overwrite: args.overwrite,
    reuseKeyPath: args.reuseKeyPath,
  });
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
}
