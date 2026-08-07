/**
 * Regression test for the #p-gating BLIND SPOT fixed in v1.5.0.
 *
 * THE BUG
 *   The relay rejects an un-p-gated `{kinds:[9]}` REQ with
 *     "restricted: p-gated events require #p matching your pubkey"
 *   so subscribe.js can ONLY ever receive messages carrying #p:<agent>.
 *   Clients that do not attach that tag -- notably the Buzz phone app, even
 *   when the user types the agent's name or uses reply -- were therefore
 *   invisible to the listener. The message was stored by the relay, visible to
 *   every human in the channel, and the agent never saw it. Measured on one
 *   deployment: 25 of 97 messages over 14 days had no #p tag.
 *
 * WHAT THIS PROVES
 *   [A] the pure tag/room predicates behave, including the exact phone case
 *       (an "e"/reply tag with no "p" tag)
 *   [B] the scanner emits un-p-tagged messages and NEVER p-tagged ones, so the
 *       subscription and the scanner handle provably disjoint sets and cannot
 *       both answer the same message
 *   [C] first run seeds silently (a fresh install must not answer history)
 *   [D] only the NEWEST unhandled message is emitted (a restart after downtime
 *       must not fire a burst)
 *   [E] state round-trips, so a restart does not re-answer handled messages
 *   [F] handler.js applies requireMention EXCEPT in a 1:1 room -- without this
 *       a bare "i'm good too" from a phone stays unanswered, which is the very
 *       symptom this release fixes
 *
 * Hermetic: no network, no relay, no credentials. The `buzz` CLI is replaced by
 * a fake executable that serves fixtures from a temp dir.
 * Run:  node listener/blindspot.test.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { hasPTagFor, isOneToOneRoom, isTargetChannel, BlindspotScanner } from './blindspot.js';
import { Handler } from './handler.js';

const SELF = 'a87934c6addad2e9564dcc6b3e28b4b05af6e069851277f995afc7370810179e';
const THEM = 'fc12db5fa2a7f390b701f3cc5b5bc08a7ced1b5bc1273b79c84c4e3650f596fc';
const CHAN = '9084741e-f3df-44f4-b990-ee24a1b10fca';

let pass = 0, fail = 0;
const check = (name, cond) => {
  if (cond) { pass++; console.log('PASS :: ' + name); }
  else { fail++; console.log('FAIL :: ' + name); }
};

// ---------------------------------------------------------------------------
// Fake `buzz` CLI: dispatches on argv, serves JSON from $FIXTURE_DIR.
// ---------------------------------------------------------------------------
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'blindspot-test-'));
const FAKE_BUZZ = path.join(TMP, 'fake-buzz');
fs.writeFileSync(FAKE_BUZZ, `#!/bin/sh
if [ "$1" = "channels" ]; then cat "$FIXTURE_DIR/channels.json"; exit 0; fi
if [ "$1" = "messages" ] && [ "$2" = "get" ]; then cat "$FIXTURE_DIR/messages.json"; exit 0; fi
echo "unexpected argv: $*" >&2; exit 1
`);
fs.chmodSync(FAKE_BUZZ, 0o755);
process.env.FIXTURE_DIR = TMP;

const writeChannels = (chans) => fs.writeFileSync(path.join(TMP, 'channels.json'), JSON.stringify(chans));
const writeMessages = (msgs) => fs.writeFileSync(path.join(TMP, 'messages.json'), JSON.stringify(msgs));

const msg = (id, pubkey, content, tags, createdAt) => ({
  id, pubkey, content, tags, kind: 9, created_at: createdAt,
});
const pTag = [['h', CHAN], ['p', SELF]];
const noTag = [['h', CHAN]];
const replyTagOnly = [['h', CHAN], ['e', 'abc123', '', 'reply']]; // the phone case

function newScanner(onEvent, tuning = {}) {
  return new BlindspotScanner({
    buzzBin: FAKE_BUZZ,
    privateKey: 'nsec-not-used-by-fake',
    selfPubkey: SELF,
    onEvent,
    log: () => {},
    tuning: { intervalMs: 999999, ...tuning }, // never auto-tick; we drive _tick()
  });
}

// ===========================================================================
console.log('--- [A] pure predicates ---');
check('p-tag for us -> true', hasPTagFor({ tags: pTag }, SELF));
check('p-tag for someone else -> false', !hasPTagFor({ tags: [['p', THEM]] }, SELF));
check('channel tag only -> false', !hasPTagFor({ tags: noTag }, SELF));
check('reply tag, no p tag -> false (the phone case)', !hasPTagFor({ tags: replyTagOnly }, SELF));
check('missing tags -> false', !hasPTagFor({}, SELF));
check('malformed tags -> false', !hasPTagFor({ tags: [null, 'p', ['p']] }, SELF));
check('"DM" is a 1:1 room', isOneToOneRoom({ name: 'DM' }));
check('"general" is not a 1:1 room', !isOneToOneRoom({ name: 'general' }));
check('nameless channel is not 1:1', !isOneToOneRoom({}));
check('dms_only skips "general"', !isTargetChannel({ name: 'general' }, 'dms_only'));
check('all_channels includes "general"', isTargetChannel({ name: 'general' }, 'all_channels'));

// ===========================================================================
console.log('\n--- [C] first run seeds silently ---');
writeChannels([{ channel_id: CHAN, name: 'DM' }]);
writeMessages([
  msg('m1', THEM, 'old message one', noTag, 1000),
  msg('m2', THEM, 'old message two', noTag, 2000),
]);
let emitted = [];
const s1 = newScanner((e) => emitted.push(e));
await s1._tick();
check('fresh install emits nothing (history not answered)', emitted.length === 0);
check('seeding flips the seeded flag', s1.getState().seeded === true);
check('seeded run recorded the backlog ids', s1.getState().channels[CHAN].seenIds.length === 2);

// ===========================================================================
console.log('\n--- [B] disjoint sets: p-tagged is never emitted ---');
writeMessages([
  msg('m1', THEM, 'old message one', noTag, 1000),
  msg('m2', THEM, 'old message two', noTag, 2000),
  msg('m3', THEM, 'tagged from desktop', pTag, 3000),   // subscription's job
]);
emitted = [];
await s1._tick();
check('p-tagged message NOT emitted (subscription owns it)', emitted.length === 0);
check('p-tagged skip is counted', s1.stats.skippedPTag >= 1);

writeMessages([
  msg('m3', THEM, 'tagged from desktop', pTag, 3000),
  msg('m4', THEM, 'hey from phone', noTag, 4000),       // blind spot
]);
emitted = [];
await s1._tick();
check('un-p-tagged message IS emitted', emitted.length === 1);
check('the emitted message is the phone one', emitted[0]?.id === 'm4');

console.log('\n--- own messages are ignored ---');
writeMessages([
  msg('m4', THEM, 'hey from phone', noTag, 4000),
  msg('m5', SELF, 'our own reply', noTag, 5000),
]);
emitted = [];
await s1._tick();
check('agent never replies to itself', emitted.length === 0);

// ===========================================================================
console.log('\n--- [D] burst control: newest unhandled only ---');
writeChannels([{ channel_id: CHAN, name: 'DM' }]);
writeMessages([msg('seed', THEM, 'seed', noTag, 100)]);
emitted = [];
const s2 = newScanner((e) => emitted.push(e));
await s2._tick();                       // seed
writeMessages([
  msg('seed', THEM, 'seed', noTag, 100),
  msg('b1', THEM, 'backlog one', noTag, 200),
  msg('b2', THEM, 'backlog two', noTag, 300),
  msg('b3', THEM, 'backlog three', noTag, 400),
]);
emitted = [];
await s2._tick();
check('3 unhandled messages produce exactly 1 emit', emitted.length === 1);
check('the emit is the NEWEST message', emitted[0]?.id === 'b3');
emitted = [];
await s2._tick();
check('older skipped messages are not re-emitted later', emitted.length === 0);

// ===========================================================================
console.log('\n--- [E] state round-trip survives a restart ---');
const saved = JSON.parse(JSON.stringify(s2.getState()));
emitted = [];
const s3 = newScanner((e) => emitted.push(e));
s3.seedState(saved);
await s3._tick();
check('restart does not re-answer handled messages', emitted.length === 0);
check('restored cursor is preserved', s3.getState().channels[CHAN].lastCreatedAt === 400);

const s4 = newScanner(() => {});
s4.seedState({ seeded: true, channels: {} });
check('seedState({seeded:true}) suppresses re-seeding', s4.getState().seeded === true);

// ===========================================================================
console.log('\n--- [F] handler: requireMention vs 1:1 rooms ---');
function ingestOne(ctx, content) {
  const seen = [];
  const h = new Handler({
    selfPubkey: SELF,
    onIntent: (i) => seen.push(i),
    tuning: { debounceMs: 1, agentName: 'Annie', agentAliases: ['@annie'], requireMention: true },
    log: () => {},
  });
  h.ingest(
    { id: 'e' + Math.random(), pubkey: THEM, kind: 9, content, created_at: 9000, tags: noTag },
    { live: true, ...ctx }
  );
  return new Promise((r) => setTimeout(() => r(seen), 30));
}

const ambient = await ingestOne({ source: 'blindspot' }, 'unrelated chatter');
check('requireMention still suppresses ambient chatter in a group room', ambient.length === 0);

const oneToOne = await ingestOne({ source: 'blindspot', isOneToOne: true }, "i'm good too");
check('a bare message in a 1:1 DM IS answered (the reported symptom)', oneToOne.length === 1);
check('intent records source=blindspot', oneToOne[0]?.source === 'blindspot');
check('intent records mentionMethod=none', oneToOne[0]?.mentionMethod === 'none');

const named = await ingestOne({ source: 'blindspot' }, 'hey Annie, you there?');
check('name mention alone still works in a group room', named.length === 1);

// ===========================================================================
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
