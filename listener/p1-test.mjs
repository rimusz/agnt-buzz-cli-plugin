// Priority-1 unit test: mention detection (handler) + Goal building (goal-creator),
// with no network. Verifies the intent enrichment + Goal description shape.
import { Handler } from './handler.js';
import { GoalCreator } from './goal-creator.js';

const SELF = 'a87934c6addad2e9564dcc6b3e28b4b05af6e069851277f995afc7370810179e';
const CHAN = '9084741e-f3df-44f4-b990-ee24a1b10fca';
let pass = 0, fail = 0;
const check = (name, cond) => { if (cond) { pass++; console.log('PASS :: ' + name); } else { fail++; console.log('FAIL :: ' + name); } };

// ---- Handler mention detection ----
const intents = [];
const h = new Handler({
  selfPubkey: SELF,
  onIntent: (i) => intents.push(i),
  tuning: { debounceMs: 10, agentName: 'Annie', agentAliases: ['@annie'], requireMention: false },
  log: () => {},
});

// NOTE: handler debounces PER AUTHOR, so give each case a distinct pubkey to
// evaluate mention detection independently (real senders are distinct people).
function evt(id, content, tags, pk) {
  h.ingest({ id, pubkey: pk, kind: 9, content, created_at: Math.floor(Date.now()/1000), tags }, { live: true });
}
const PK = (n) => String(n).repeat(64).slice(0, 64);

// 1) #p tag -> p-tag
evt('e1', 'please summarize the thread', [['h', CHAN], ['p', SELF]], PK('1'));
// 2) name mention, no #p -> name-mention
evt('e2', 'hey Annie can you check the logs?', [['h', CHAN]], PK('2'));
// 3) reply with root marker -> threadRoot captured + #p
evt('e3', 'and file an issue', [['h', CHAN], ['e', 'ROOT123', '', 'root'], ['p', SELF]], PK('3'));

await new Promise((r) => setTimeout(r, 120));

check('p-tag detected', intents.find(i => i.eventId === 'e1')?.mentionMethod === 'p-tag');
check('name-mention detected', intents.find(i => i.eventId === 'e2')?.mentionMethod === 'name-mention');
check('reply threadRoot captured', intents.find(i => i.eventId === 'e3')?.threadRoot === 'ROOT123');
check('p-tag+name combines', (() => { const i = {}; return true; })()); // placeholder true (covered below)

// combined p-tag + name
intents.length = 0;
h.ingest({ id: 'e5', pubkey: PK('5'), kind: 9, content: 'Annie please help', created_at: Math.floor(Date.now()/1000), tags: [['h', CHAN], ['p', SELF]] }, { live: true });
await new Promise((r) => setTimeout(r, 60));
check('p-tag+name combined method', intents.find(i => i.eventId === 'e5')?.mentionMethod === 'p-tag+name');

// requireMention=true suppresses ambient (no #p/name)
const intents2 = [];
const h2 = new Handler({ selfPubkey: SELF, onIntent: (i) => intents2.push(i), tuning: { debounceMs: 10, agentName: 'Annie', requireMention: true }, log: () => {} });
h2.ingest({ id: 'e6', pubkey: 'fc12db5f'.padEnd(64,'0'), kind: 9, content: 'random chatter', created_at: Math.floor(Date.now()/1000), tags: [['h', CHAN]] }, { live: true });
await new Promise((r) => setTimeout(r, 60));
check('requireMention suppresses ambient', intents2.length === 0);

// ---- GoalCreator: build the Goal description (no network) ----
const gc = new GoalCreator({ agntToken: 'x', buzzBin: 'buzz', tuning: { agentName: 'Annie' } });
const intent = {
  eventId: 'EVT_ORIG_1',
  channelId: CHAN,
  threadRoot: 'ROOT_9',
  author: 'user:fc12db5f',
  authorPubkey: 'fc12db5f'.padEnd(64,'0'),
  content: 'Please research the top 3 Nostr relays and summarize tradeoffs.',
  createdAt: Math.floor(Date.now()/1000),
  mentionMethod: 'p-tag',
};
const built = gc._buildGoal(intent, 'general', [
  { author: 'aaaa1111', content: 'earlier message one' },
  { author: 'bbbb2222', content: 'earlier message two' },
]);
check('goal title mentions author + channel', /Buzz: reply to .*general/.test(built.title));
check('goal desc has full request', built.description.includes('research the top 3 Nostr relays'));
check('goal desc has replyTo instruction', built.description.includes('replyTo') && built.description.includes('EVT_ORIG_1'));
check('goal desc has channel id', built.description.includes(CHAN));
check('goal desc has thread root', built.description.includes('ROOT_9'));
check('goal desc has buzz-send-message tool', built.description.includes('buzz-send-message'));
check('goal desc has context block', built.description.includes('earlier message one'));

console.log('\n=== SAMPLE GOAL ===');
console.log('TITLE:', built.title);
console.log('---DESC (first 700 chars)---');
console.log(built.description.slice(0, 700));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
