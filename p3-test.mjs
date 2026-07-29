// Priority-3 unit test: membership tool shape + keygen status/rotation surface (no network, no keygen).
import { listPublicIdentities } from './buzz-keygen.js';

let pass = 0, fail = 0;
const check = (n, c) => { if (c) { pass++; console.log('PASS :: ' + n); } else { fail++; console.log('FAIL :: ' + n); } };

// check-membership tool loads + validates shape
const mem = (await import('./buzz-check-membership.js')).default;
check('check-membership tool name', mem.name === 'buzz-check-membership');
check('check-membership has execute', typeof mem.execute === 'function');

// provision + list-identities tools load
const prov = (await import('./buzz-provision-identity.js')).default;
check('provision tool loads', prov.name === 'buzz-provision-identity');
const list = (await import('./buzz-list-identities.js')).default;
check('list-identities tool loads', list.name === 'buzz-list-identities');

// keygen exports rotateAgentIdentity
const keygen = await import('./buzz-keygen.js');
check('rotateAgentIdentity exported', typeof keygen.rotateAgentIdentity === 'function');
check('provisionAgentIdentity exported', typeof keygen.provisionAgentIdentity === 'function');

// listPublicIdentities returns status-enriched shape (uses real registry if present, else empty)
const data = listPublicIdentities();
check('list has count', typeof data.count === 'number');
check('list has okCount', typeof data.okCount === 'number');
check('list has needsAttention array', Array.isArray(data.needsAttention));
// each agent (if any) has status fields
const shapeOk = (data.agents || []).every(
  (a) => 'hasKey' in a && 'provisioned' in a && 'status' in a && 'npub' in a
);
check('each identity has status fields', shapeOk);

// provision tool: rotate without name is allowed at the tool layer (agentId only) --
// verify the tool does NOT reject rotate:true for missing name (it will fail later on
// no-agentId, so we pass an agentId and expect it to attempt rotation path, not a name error).
const r = await prov.execute({ agentId: '00000000-test', rotate: true }, {}, null);
// It will likely error trying to archive/keygen for a non-existent agent, but must NOT
// be the "name is required" user_input error.
check('rotate does not require name', !(r.success === false && /name is required/i.test(r.error || '')));

console.log('\n=== identity status sample ===');
console.log(JSON.stringify({ count: data.count, okCount: data.okCount, needsAttention: data.needsAttention }, null, 2));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
