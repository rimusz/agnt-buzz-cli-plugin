/**
 * Regression test for the reconnect bug fixed in v1.4.4.
 *
 * THE BUG
 *   RelaySocket._scheduleReconnect() was reachable only from ws.onclose. The
 *   connect-timeout path called ws.close() and *assumed* onclose would follow.
 *   With Node/undici WebSocket, close() on a socket still in CONNECTING whose
 *   handshake already failed emits 'error' and NEVER fires 'close'. So no
 *   reconnect was scheduled, every timer was released, the event loop drained,
 *   and the process exited 0 -- which a launchd KeepAlive of
 *   {SuccessfulExit=false} deliberately ignores. Result: a silent, permanent
 *   outage triggered by an ordinary relay restart.
 *
 * WHAT THIS PROVES
 *   Case [1] runs the PRE-FIX file (pulled from git history) and asserts it
 *   FAILS to reconnect -- so the suite reproduces the real bug rather than a
 *   strawman. Cases [2]-[5] assert the current file behaves.
 *
 * Hermetic: no network, no relay, no credentials, no @noble dependency
 * (nostr.js is stubbed). Run:  node listener/reconnect-regression.test.mjs
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PREFIX_REF = process.env.PREFIX_REF || 'v1.4.3'; // last release before the fix

let pass = 0, fail = 0, skip = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  PASS  ' + name); }
  else { fail++; console.log('  FAIL  ' + name + (extra ? '  :: ' + extra : '')); }
};

/**
 * Stub nostr.js -- keeps the test free of @noble/curves so it runs anywhere.
 * relay-socket.js only needs these four exports.
 */
const NOSTR_STUB = `
export function decodeNsec() { return new Uint8Array(32); }
export function getPublicKey() { return 'f'.repeat(64); }
export function buildAuthEvent() { return { id: 'stub', sig: 'stub', kind: 22242, tags: [], content: '' }; }
export function toWebsocketUrl(u) { return String(u).replace(/^http/, 'ws'); }
`;

/** Build a sandbox holding one version of relay-socket.js + the stub. */
function sandbox(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'buzz-relaysock-'));
  fs.writeFileSync(path.join(dir, 'nostr.js'), NOSTR_STUB);
  fs.writeFileSync(path.join(dir, 'relay-socket.js'), source);
  return path.join(dir, 'relay-socket.js');
}

function currentSource() {
  return fs.readFileSync(path.join(HERE, 'relay-socket.js'), 'utf8');
}

function preFixSource() {
  try {
    return execSync(`git show ${PREFIX_REF}:listener/relay-socket.js`, {
      cwd: path.resolve(HERE, '..'), encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null; // shallow clone / no git -- case [1] is skipped
  }
}

/**
 * Fake WebSocket reproducing undici semantics for a failed handshake.
 *   'stuck-then-error' never opens; close() emits ONLY an error  (the bug)
 *   'stuck-then-close' never opens; close() properly fires onclose
 */
let MODE = 'stuck-then-error';
const created = [];

class FakeWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.onopen = this.onmessage = this.onerror = this.onclose = null;
    created.push(this);
  }
  send() {}
  close(code) {
    if (MODE === 'stuck-then-error') {
      this.readyState = 3;
      this.onerror && this.onerror({
        message: 'Connection was closed before it was established.',
        error: new Error('Connection was closed before it was established.'),
      });
      return; // onclose deliberately NEVER fires
    }
    this.readyState = 3;
    this.onclose && this.onclose({ code: code || 1006, reason: '' });
  }
}
globalThis.WebSocket = FakeWS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeSocket(RelaySocket) {
  return new RelaySocket({
    relayUrl: 'https://relay.invalid',
    nsec: 'a'.repeat(63) + '1', // throwaway, never a real credential
    log: () => {},
    tuning: {
      connectTimeoutMs: 40, minBackoffMs: 20, maxBackoffMs: 60,
      authTimeoutMs: 10000, pingIntervalMs: 0,
    },
  });
}

async function scenario(source, mode) {
  MODE = mode;
  created.length = 0;
  const mod = await import('file://' + sandbox(source) + '?t=' + Date.now());
  const RelaySocket = mod.RelaySocket || mod.default;
  const s = makeSocket(RelaySocket);
  const seen = { reconnecting: 0, dropped: 0, giveup: 0 };
  s.on('reconnecting', () => seen.reconnecting++);
  s.on('dropped', () => seen.dropped++);
  s.on('error', () => {});
  s.on('giveup', () => seen.giveup++);
  s.start();
  await sleep(400);
  s.stopLink();
  return { seen, sockets: created.length };
}

console.log('\nbuzz-cli-plugin listener -- reconnect regression suite');

console.log('\n[1] PRE-FIX code (' + PREFIX_REF + '), outage scenario');
{
  const src = preFixSource();
  if (!src) {
    skip++;
    console.log('  SKIP  no git history for ' + PREFIX_REF + ' (shallow clone?)');
  } else {
    const r = await scenario(src, 'stuck-then-error');
    ok('reproduces the bug: NO reconnect scheduled', r.seen.reconnecting === 0,
      'reconnecting=' + r.seen.reconnecting);
    ok('reproduces the bug: link left dead (1 socket only)', r.sockets === 1,
      'sockets=' + r.sockets);
    ok('reproduces the bug: no giveup either', r.seen.giveup === 0);
  }
}

console.log('\n[2] CURRENT code, same outage scenario');
{
  const r = await scenario(currentSource(), 'stuck-then-error');
  ok('reconnect IS scheduled', r.seen.reconnecting >= 1, 'reconnecting=' + r.seen.reconnecting);
  ok('link actually retries (>1 socket)', r.sockets > 1, 'sockets=' + r.sockets);
  ok('exactly one dropped per failed socket', r.seen.dropped === r.sockets,
    'dropped=' + r.seen.dropped + ' sockets=' + r.sockets);
}

console.log('\n[3] CURRENT code, well-behaved close (no regression)');
{
  const r = await scenario(currentSource(), 'stuck-then-close');
  ok('reconnect scheduled', r.seen.reconnecting >= 1);
  ok('no duplicate dropped events', r.seen.dropped === r.sockets,
    'dropped=' + r.seen.dropped + ' sockets=' + r.sockets);
}

console.log('\n[4] CURRENT code, idempotency: timeout AND a late close for one socket');
{
  MODE = 'stuck-then-close';
  created.length = 0;
  const mod = await import('file://' + sandbox(currentSource()) + '?t=' + Date.now());
  const RelaySocket = mod.RelaySocket || mod.default;
  const s = makeSocket(RelaySocket);
  let dropped = 0;
  s.on('dropped', () => dropped++);
  s.on('error', () => {});
  s.start();
  const first = created[0];
  await sleep(120);
  try { first.onclose && first.onclose({ code: 1006, reason: 'late' }); } catch {}
  await sleep(60);
  ok('late duplicate close does not double-fire dropped', dropped <= created.length,
    'dropped=' + dropped + ' sockets=' + created.length);
  s.stopLink();
}

console.log('\n[5] CURRENT code, stopLink() still cancels reconnects');
{
  MODE = 'stuck-then-error';
  created.length = 0;
  const mod = await import('file://' + sandbox(currentSource()) + '?t=' + Date.now());
  const RelaySocket = mod.RelaySocket || mod.default;
  const s = makeSocket(RelaySocket);
  s.on('error', () => {});
  s.start();
  await sleep(120);
  s.stopLink();
  const after = created.length;
  await sleep(250);
  ok('no new sockets after stopLink()', created.length === after,
    'before=' + after + ' after=' + created.length);
}

console.log('\n[6] installer ships an unconditional KeepAlive');
{
  const sh = fs.readFileSync(path.join(HERE, 'install-listener.sh'), 'utf8');
  const directive = sh.match(/<key>KeepAlive<\/key>\s*(<true\/>|<dict>)/);
  ok('KeepAlive is <true/>, not a SuccessfulExit dict',
    !!directive && directive[1] === '<true/>',
    directive ? directive[1] : 'not found');
  ok('systemd unit uses Restart=always', /Restart=always/.test(sh));
}

console.log('\n----------------------------------------');
console.log('  ' + pass + ' passed, ' + fail + ' failed' + (skip ? ', ' + skip + ' skipped' : ''));
console.log('----------------------------------------\n');
process.exit(fail === 0 ? 0 : 1);
