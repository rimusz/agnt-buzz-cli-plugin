/**
 * Nostr key generation + public metadata helpers for Buzz identities.
 * Private keys are written to disk only — never returned to tool callers.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { createRequire } from 'module';
import { spawnSync } from 'child_process';
import {
  identitiesRoot,
  keysDir,
  loadRegistry,
  saveRegistry,
  bindAgentIdentity,
  registryPath,
} from './buzz-identity.js';

// --- bech32 (npub/nsec) ---
const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
function polymod(values) {
  const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
  let chk = 1;
  for (const v of values) {
    const b = chk >> 25;
    chk = ((chk & 0x1ffffff) << 5) ^ v;
    for (let i = 0; i < 5; i++) if ((b >> i) & 1) chk ^= GEN[i];
  }
  return chk;
}
function hrpExpand(hrp) {
  const ret = [];
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) >> 5);
  ret.push(0);
  for (let i = 0; i < hrp.length; i++) ret.push(hrp.charCodeAt(i) & 31);
  return ret;
}
function createChecksum(hrp, data) {
  const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
  const mod = polymod(values) ^ 1;
  const ret = [];
  for (let p = 0; p < 6; p++) ret.push((mod >> (5 * (5 - p))) & 31);
  return ret;
}
function bech32Encode(hrp, data) {
  const combined = data.concat(createChecksum(hrp, data));
  let ret = hrp + '1';
  for (const d of combined) ret += CHARSET.charAt(d);
  return ret;
}
function convertBits(data, from, to, pad) {
  let acc = 0;
  let bits = 0;
  const ret = [];
  const maxv = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      ret.push((acc >> bits) & maxv);
    }
  }
  if (pad) {
    if (bits > 0) ret.push((acc << (to - bits)) & maxv);
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    return null;
  }
  return ret;
}
function hexToBytes(hex) {
  const out = [];
  for (let i = 0; i < hex.length; i += 2) out.push(parseInt(hex.slice(i, i + 2), 16));
  return out;
}

export function encodeNsec(privHex) {
  const data = convertBits(hexToBytes(privHex), 8, 5, true);
  return bech32Encode('nsec', data);
}

export function encodeNpub(pubHex) {
  const data = convertBits(hexToBytes(pubHex), 8, 5, true);
  return bech32Encode('npub', data);
}

function loadSecp() {
  const candidates = [
    path.join(os.homedir(), '.agnt-server/backend/package.json'),
    '/Users/tom/.agnt-server/backend/package.json',
    path.join(process.cwd(), 'package.json'),
  ];
  let lastErr;
  for (const pkg of candidates) {
    if (!fs.existsSync(pkg)) continue;
    try {
      const require = createRequire(pkg);
      try {
        return require('@noble/curves/secp256k1').secp256k1;
      } catch (e1) {
        lastErr = e1;
        return require('@noble/curves/esm/secp256k1.js').secp256k1;
      }
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error(
    `Cannot load @noble/curves for keygen (${lastErr?.message || 'not found'}). AGNT backend deps required.`
  );
}

/** Generate a fresh Nostr keypair. Caller must store nsec securely — do not log. */
export function generateKeypair() {
  const secp256k1 = loadSecp();
  let priv;
  do {
    priv = secp256k1.utils.randomPrivateKey();
  } while (!secp256k1.utils.isValidPrivateKey(priv));
  const pub = secp256k1.getPublicKey(priv, true); // compressed
  const pubX = Buffer.from(pub.slice(1)).toString('hex');
  const privHex = Buffer.from(priv).toString('hex');
  return {
    privHex,
    pubHex: pubX,
    nsec: encodeNsec(privHex),
    npub: encodeNpub(pubX),
  };
}

export function slugify(s) {
  return (
    String(s || 'agent')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'agent'
  );
}

function ensureStrictRegistry() {
  const reg = loadRegistry();
  reg.allowSharedEnvKey = false;
  reg.requireAgentIdentity = true;
  reg.version = reg.version || 1;
  if (!reg.agents) reg.agents = {};
  saveRegistry(reg);
  return reg;
}

function runBuzz(args, envExtra = {}) {
  const bin = process.env.BUZZ_BIN || '/Users/tom/.cargo/bin/buzz';
  const r = spawnSync(bin, args, {
    encoding: 'utf8',
    env: {
      ...process.env,
      ...envExtra,
      PATH: `/Users/tom/.cargo/bin:${process.env.PATH || ''}`,
    },
    timeout: 60000,
  });
  return {
    exit: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
  };
}

/**
 * Provision identity for an AGNT agent.
 * Returns PUBLIC metadata only (never nsec / privHex).
 *
 * @param {object} opts
 * @param {string} opts.agentId
 * @param {string} opts.name
 * @param {string} [opts.displayName]
 * @param {string} [opts.relayUrl]
 * @param {boolean} [opts.inviteGeneral]
 * @param {boolean} [opts.overwrite] - if true, replace existing key (dangerous)
 * @param {string} [opts.reuseKeyPath] - path to existing nsec/hex file
 */
export function provisionAgentIdentity(opts = {}) {
  const agentId = String(opts.agentId || '').trim();
  const name = String(opts.name || '').trim();
  if (!agentId) throw new Error('agentId is required');
  if (!name) throw new Error('name is required');

  const displayName = String(opts.displayName || name).trim();
  const relay =
    opts.relayUrl ||
    process.env.BUZZ_RELAY_URL ||
    'https://relay.example.com';

  fs.mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  ensureStrictRegistry();

  const reg = loadRegistry();
  const existing = reg.agents[agentId];
  const keyPath = path.join(keysDir(), `${agentId}.key`);

  // Already bound and not overwriting → return public info only
  if (existing && fs.existsSync(existing.keyPath || keyPath) && !opts.overwrite && !opts.reuseKeyPath) {
    const pub = existing.pubkeyHex || null;
    return {
      created: false,
      alreadyExists: true,
      agentId,
      agentName: existing.agentName || name,
      displayName: existing.displayName || displayName,
      pubkeyHex: pub,
      npub: pub ? encodeNpub(pub) : null,
      keyPath: existing.keyPath || keyPath,
      relayUrl: existing.relayUrl || relay,
      registry: registryPath(),
      note: 'Identity already registered. Public key only (private key never returned).',
    };
  }

  if (fs.existsSync(keyPath) && !opts.overwrite && !opts.reuseKeyPath) {
    throw new Error(
      `Key file already exists for ${agentId}. Pass overwrite=true to replace, or list existing identity.`
    );
  }

  let privMaterial;
  let pubHex = null;
  let npub = null;

  if (opts.reuseKeyPath) {
    const reuse = path.resolve(String(opts.reuseKeyPath).replace(/^~/, os.homedir()));
    if (!fs.existsSync(reuse)) throw new Error(`reuseKeyPath not found: ${reuse}`);
    privMaterial = fs.readFileSync(reuse, 'utf8').replace(/\s+/g, '');
    fs.writeFileSync(keyPath, privMaterial + '\n', { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
  } else {
    const kp = generateKeypair();
    privMaterial = kp.nsec;
    pubHex = kp.pubHex;
    npub = kp.npub;
    fs.writeFileSync(keyPath, kp.nsec + '\n', { mode: 0o600 });
    fs.chmodSync(keyPath, 0o600);
  }

  // Best-effort profile + whoami for pubkey
  const about = `AGNT agent "${name}" — unique Buzz identity (per-agent nsec).`;
  runBuzz(['users', 'set-profile', '--display-name', displayName, '--about', about], {
    BUZZ_PRIVATE_KEY: privMaterial,
    BUZZ_RELAY_URL: relay,
  });

  const who = runBuzz(['users', 'get'], {
    BUZZ_PRIVATE_KEY: privMaterial,
    BUZZ_RELAY_URL: relay,
  });
  if (who.exit === 0) {
    try {
      const arr = JSON.parse(who.stdout);
      pubHex = arr[0]?.pubkey || pubHex;
      if (pubHex && !npub) npub = encodeNpub(pubHex);
    } catch {
      /* ignore */
    }
  }

  bindAgentIdentity({
    agentId,
    agentName: name,
    displayName,
    keyPath,
    pubkeyHex: pubHex || null,
    relayUrl: relay,
    note: 'Provisioned via buzz-provision-identity (public metadata only in tool results)',
  });

  const cardPath = path.join(identitiesRoot(), `${slugify(name)}.identity.json`);
  const card = {
    agentId,
    agentName: name,
    display_name: displayName,
    pubkey_hex: pubHex || null,
    npub: npub || null,
    key_path: keyPath,
    relay,
    created_at: new Date().toISOString(),
    usage: 'Resolved by buzz-cli-plugin via agentId → registry. Private key never exposed to tools.',
  };
  fs.writeFileSync(cardPath, JSON.stringify(card, null, 2) + '\n', { mode: 0o600 });

  let generalJoin = null;
  if (opts.inviteGeneral) {
    const general = '30f7347c-d44d-5555-959b-36ae778f3abd';
    const join = runBuzz(['channels', 'join', '--channel', general], {
      BUZZ_PRIVATE_KEY: privMaterial,
      BUZZ_RELAY_URL: relay,
    });
    generalJoin = {
      exit: join.exit,
      accepted: join.exit === 0,
      detail: (join.stdout || join.stderr || '').slice(0, 200),
    };
  }

  // scrub
  privMaterial = null;

  return {
    created: true,
    alreadyExists: false,
    agentId,
    agentName: name,
    displayName,
    pubkeyHex: pubHex,
    npub: npub || (pubHex ? encodeNpub(pubHex) : null),
    keyPath,
    identityCard: cardPath,
    relayUrl: relay,
    registry: registryPath(),
    generalJoin,
    note:
      'Private key stored on disk only (not returned). Invite pubkey/npub into Buzz if the community is closed.',
  };
}

/** Public-only list of registered identities */
export function listPublicIdentities() {
  const reg = loadRegistry();
  const agents = Object.entries(reg.agents || {}).map(([id, e]) => ({
    agentId: id,
    agentName: e.agentName || null,
    displayName: e.displayName || null,
    pubkeyHex: e.pubkeyHex || null,
    npub: e.pubkeyHex ? encodeNpub(e.pubkeyHex) : null,
    relayUrl: e.relayUrl || null,
    keyPath: e.keyPath || null,
    createdAt: e.createdAt || null,
  }));
  return {
    allowSharedEnvKey: reg.allowSharedEnvKey === true,
    requireAgentIdentity: reg.requireAgentIdentity !== false,
    registry: registryPath(),
    count: agents.length,
    agents,
  };
}
