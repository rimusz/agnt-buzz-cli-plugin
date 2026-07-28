/**
 * nostr.js — minimal, dependency-light Nostr primitives for the Buzz listener.
 *
 *   - decodeNsec(nsec|hex)  -> 32-byte secret key (Uint8Array)
 *   - getPublicKey(sk)      -> 32-byte x-only pubkey hex
 *   - signEvent(evt, sk)    -> event with id + pubkey + sig filled in (NIP-01)
 *   - buildAuthEvent(...)   -> signed kind-22242 NIP-42 auth event
 *   - toWebsocketUrl(url)   -> https:// -> wss://
 *
 * Crypto comes from @noble/curves + @noble/hashes. These ship with any AGNT
 * install (the backend depends on them). We locate them by, in order:
 *   1. NOBLE_BASE env var (a node_modules dir containing @noble/*)
 *   2. walking up from this file to find a node_modules with @noble/curves
 *   3. bare import (works if @noble/* is installed alongside this listener)
 *
 * This module has ZERO Buzz/relay knowledge — pure Nostr, unit-testable.
 */

import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- locate @noble/curves + @noble/hashes ----
function findNobleBases() {
  const bases = [];
  if (process.env.NOBLE_BASE) bases.push(process.env.NOBLE_BASE);

  // walk up from this file looking for node_modules/@noble/curves
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const nm = path.join(dir, 'node_modules');
    if (fs.existsSync(path.join(nm, '@noble', 'curves'))) bases.push(nm);
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // common AGNT install locations (best-effort, harmless if absent)
  const home = process.env.HOME || process.env.USERPROFILE || '';
  if (home) {
    bases.push(path.join(home, '.agnt-server', 'backend', 'node_modules'));
    bases.push(path.join(home, '.agnt-server', 'node_modules'));
  }
  bases.push(null); // bare import fallback
  return bases;
}

function resolveNoble() {
  for (const base of findNobleBases()) {
    if (base !== null && !fs.existsSync(path.join(base, '@noble', 'curves'))) continue;
    try {
      const curvesPath = base ? path.join(base, '@noble/curves/secp256k1.js') : '@noble/curves/secp256k1.js';
      const hashesPath = base ? path.join(base, '@noble/hashes/sha256.js') : '@noble/hashes/sha256.js';
      const { schnorr } = require(curvesPath);
      const { sha256 } = require(hashesPath);
      return { schnorr, sha256 };
    } catch {
      /* try next */
    }
  }
  throw new Error(
    'nostr.js: could not load @noble/curves + @noble/hashes. Set NOBLE_BASE to a ' +
      'node_modules dir that contains them (any AGNT backend has them).'
  );
}

const { schnorr, sha256 } = resolveNoble();

const enc = new TextEncoder();
const toHex = (bytes) => Buffer.from(bytes).toString('hex');

// ---------------------------------------------------------------------------
// bech32 decode (nsec). Minimal — no checksum verification (fine for a
// locally-owned key file).
// ---------------------------------------------------------------------------
const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

function bech32ToBytes(str) {
  const s = str.toLowerCase().trim();
  const sep = s.lastIndexOf('1');
  if (sep < 0) throw new Error('nostr.js: not a bech32 string (no separator)');
  const dataPart = s.slice(sep + 1);
  const values = [];
  for (const ch of dataPart) {
    const v = BECH32_CHARSET.indexOf(ch);
    if (v === -1) throw new Error(`nostr.js: invalid bech32 char "${ch}"`);
    values.push(v);
  }
  const payload = values.slice(0, -6);
  let acc = 0;
  let bits = 0;
  const out = [];
  for (const v of payload) {
    acc = (acc << 5) | v;
    bits += 5;
    while (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }
  return Uint8Array.from(out);
}

/** nsec bech32 OR 64-char hex -> 32-byte Uint8Array secret key. */
export function decodeNsec(input) {
  const s = String(input).replace(/\s+/g, '');
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Uint8Array.from(Buffer.from(s, 'hex'));
  if (s.startsWith('nsec1')) {
    const bytes = bech32ToBytes(s);
    if (bytes.length !== 32) throw new Error(`nostr.js: decoded nsec is ${bytes.length} bytes, expected 32`);
    return bytes;
  }
  throw new Error('nostr.js: key must be an nsec1... bech32 string or 64-char hex');
}

/** 32-byte x-only public key, hex-encoded. */
export function getPublicKey(sk) {
  return toHex(schnorr.getPublicKey(sk));
}

function serializeForId(evt) {
  return JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
}

/** Fills evt.pubkey/id/sig in place (NIP-01) and returns evt. */
export function signEvent(evt, sk, pubkeyHex) {
  const pk = pubkeyHex || getPublicKey(sk);
  evt.pubkey = pk;
  evt.id = toHex(sha256(enc.encode(serializeForId(evt))));
  evt.sig = toHex(schnorr.sign(evt.id, sk));
  return evt;
}

/** Signed NIP-42 AUTH event (kind 22242). */
export function buildAuthEvent({ relayUrl, challenge, sk, pubkeyHex }) {
  return signEvent(
    { created_at: Math.floor(Date.now() / 1000), kind: 22242, tags: [['relay', relayUrl], ['challenge', challenge]], content: '' },
    sk,
    pubkeyHex
  );
}

/** https:// relay base URL -> wss:// websocket URL. */
export function toWebsocketUrl(relayUrl) {
  const u = String(relayUrl).trim().replace(/\/+$/, '');
  if (u.startsWith('wss://') || u.startsWith('ws://')) return u;
  if (u.startsWith('https://')) return 'wss://' + u.slice('https://'.length);
  if (u.startsWith('http://')) return 'ws://' + u.slice('http://'.length);
  return 'wss://' + u;
}
