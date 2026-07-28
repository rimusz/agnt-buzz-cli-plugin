/**
 * Per-agent Buzz (Nostr) identity resolution.
 *
 * Policy (default): NO shared host identity.
 * Each AGNT agent must have its own nsec registered under:
 *   ~/.agnt/buzz-identities/registry.json
 *   ~/.agnt/buzz-identities/keys/<agentId>.key
 *
 * Resolution order for private key:
 *   1. Explicit tool param privateKey / buzzPrivateKey / __auth.token
 *   2. Registry mapping for agentId (from workflowEngine.context / params)
 *   3. Shared BUZZ_PRIVATE_KEY env — ONLY if allowSharedEnvKey=true (default false)
 *
 * agentId sources (first wins):
 *   params.agentId → inputData.agentId → workflowEngine.agentId → workflowEngine.agent?.id
 */

import fs from 'fs';
import path from 'path';
import os from 'os';

const DEFAULT_ROOT = path.join(os.homedir(), '.agnt', 'buzz-identities');

export function identitiesRoot() {
  return process.env.BUZZ_IDENTITIES_DIR || DEFAULT_ROOT;
}

export function registryPath() {
  return path.join(identitiesRoot(), 'registry.json');
}

export function keysDir() {
  return path.join(identitiesRoot(), 'keys');
}

function readJsonSafe(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return fallback;
  }
}

/**
 * @returns {{
 *   version: number,
 *   allowSharedEnvKey: boolean,
 *   requireAgentIdentity: boolean,
 *   agents: Record<string, {
 *     agentName?: string,
 *     displayName?: string,
 *     pubkeyHex?: string,
 *     keyPath: string,
 *     relayUrl?: string,
 *     createdAt?: string,
 *     note?: string
 *   }>
 * }}
 */
export function loadRegistry() {
  const root = identitiesRoot();
  const reg = readJsonSafe(registryPath(), null);
  if (reg && typeof reg === 'object') {
    return {
      version: reg.version || 1,
      allowSharedEnvKey: reg.allowSharedEnvKey === true,
      requireAgentIdentity: reg.requireAgentIdentity !== false, // default true
      agents: reg.agents && typeof reg.agents === 'object' ? reg.agents : {},
    };
  }
  // Defaults when missing: strict per-agent mode
  return {
    version: 1,
    allowSharedEnvKey: false,
    requireAgentIdentity: true,
    agents: {},
  };
}

export function saveRegistry(reg) {
  const root = identitiesRoot();
  fs.mkdirSync(path.join(root, 'keys'), { recursive: true, mode: 0o700 });
  const p = registryPath();
  fs.writeFileSync(p, JSON.stringify(reg, null, 2) + '\n', { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
    fs.chmodSync(root, 0o700);
    fs.chmodSync(keysDir(), 0o700);
  } catch {
    /* ignore */
  }
}

export function extractAgentId(params = {}, inputData = {}, workflowEngine = null) {
  const ctx = workflowEngine || {};
  const candidates = [
    params.agentId,
    params.agent_id,
    inputData?.agentId,
    inputData?.agent_id,
    ctx.agentId,
    ctx.agent_id,
    ctx.agent?.id,
    ctx.agent?.agentId,
    // some paths nest context
    ctx.context?.agentId,
  ];
  for (const c of candidates) {
    if (c == null || c === '') continue;
    const s = String(c).trim();
    // Skip non-agent chat placeholders that are not real agent rows
    if (s === 'orchestrator' || s === 'agent-chat') continue;
    return s;
  }
  return null;
}

function readKeyFile(keyPath) {
  if (!keyPath) return null;
  const expanded = keyPath.startsWith('~')
    ? path.join(os.homedir(), keyPath.slice(1))
    : keyPath;
  if (!fs.existsSync(expanded)) {
    throw new Error(`Buzz identity key file not found: ${expanded}`);
  }
  const raw = fs.readFileSync(expanded, 'utf8').replace(/\s+/g, '');
  if (!raw) throw new Error(`Buzz identity key file empty: ${expanded}`);
  return raw;
}

/**
 * Resolve private key + metadata for a Buzz tool call.
 * @returns {{
 *   ok: boolean,
 *   privateKey?: string,
 *   relayUrl?: string,
 *   agentId?: string|null,
 *   displayName?: string|null,
 *   pubkeyHex?: string|null,
 *   source?: string,
 *   error?: string
 * }}
 */
export function resolveIdentity(params = {}, inputData = {}, workflowEngine = null) {
  const reg = loadRegistry();
  const agentId = extractAgentId(params, inputData, workflowEngine);

  // 1) Explicit override (workflow / advanced)
  const explicit =
    params.privateKey ||
    params.buzzPrivateKey ||
    params.__auth?.token ||
    null;
  if (explicit && String(explicit).trim()) {
    return {
      ok: true,
      privateKey: String(explicit).trim(),
      relayUrl: params.relayUrl || params.buzzRelayUrl || process.env.BUZZ_RELAY_URL || null,
      agentId,
      displayName: params.displayName || null,
      pubkeyHex: null,
      source: 'param',
    };
  }

  // 2) Per-agent registry
  if (agentId && reg.agents[agentId]) {
    const entry = reg.agents[agentId];
    try {
      const privateKey = readKeyFile(entry.keyPath);
      return {
        ok: true,
        privateKey,
        relayUrl:
          params.relayUrl ||
          params.buzzRelayUrl ||
          entry.relayUrl ||
          process.env.BUZZ_RELAY_URL ||
          null,
        agentId,
        displayName: entry.displayName || entry.agentName || null,
        pubkeyHex: entry.pubkeyHex || null,
        source: 'agent-registry',
        keyPath: entry.keyPath,
      };
    } catch (e) {
      return {
        ok: false,
        agentId,
        error: e.message,
        source: 'agent-registry',
      };
    }
  }

  // 3) Shared env — disabled by default
  if (reg.allowSharedEnvKey && process.env.BUZZ_PRIVATE_KEY) {
    return {
      ok: true,
      privateKey: String(process.env.BUZZ_PRIVATE_KEY).trim(),
      relayUrl: params.relayUrl || params.buzzRelayUrl || process.env.BUZZ_RELAY_URL || null,
      agentId,
      displayName: null,
      pubkeyHex: null,
      source: 'shared-env',
    };
  }

  // Fail closed
  if (reg.requireAgentIdentity) {
    if (!agentId) {
      return {
        ok: false,
        agentId: null,
        error:
          'Buzz requires a per-agent identity, but no agentId is in context. ' +
          'Open a saved Agent chat (not bare orchestrator), or pass privateKey, ' +
          'or register an identity under ~/.agnt/buzz-identities/.',
        source: 'none',
      };
    }
    return {
      ok: false,
      agentId,
      error:
        `No Buzz identity registered for agentId=${agentId}. ` +
        `Run: node …/scripts/provision-agent-identity.js --agent-id ${agentId} --name "…" ` +
        `or add ~/.agnt/buzz-identities/registry.json mapping.`,
      source: 'none',
    };
  }

  // requireAgentIdentity=false and no key
  if (process.env.BUZZ_PRIVATE_KEY) {
    return {
      ok: true,
      privateKey: String(process.env.BUZZ_PRIVATE_KEY).trim(),
      relayUrl: params.relayUrl || process.env.BUZZ_RELAY_URL || null,
      agentId,
      source: 'shared-env-fallback',
    };
  }

  return {
    ok: false,
    agentId,
    error:
      'BUZZ_PRIVATE_KEY not set and no per-agent identity found. ' +
      'Register an agent identity under ~/.agnt/buzz-identities/.',
    source: 'none',
  };
}

/**
 * Register or update an agent mapping (does not generate keys).
 */
export function bindAgentIdentity({
  agentId,
  agentName,
  displayName,
  keyPath,
  pubkeyHex,
  relayUrl,
  note,
}) {
  if (!agentId) throw new Error('agentId required');
  if (!keyPath) throw new Error('keyPath required');
  const reg = loadRegistry();
  reg.agents[agentId] = {
    agentName: agentName || reg.agents[agentId]?.agentName || agentId,
    displayName: displayName || agentName || reg.agents[agentId]?.displayName || null,
    keyPath,
    pubkeyHex: pubkeyHex || reg.agents[agentId]?.pubkeyHex || null,
    relayUrl: relayUrl || reg.agents[agentId]?.relayUrl || process.env.BUZZ_RELAY_URL || null,
    createdAt: reg.agents[agentId]?.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    note: note || reg.agents[agentId]?.note || null,
  };
  // Strict defaults
  if (reg.allowSharedEnvKey == null) reg.allowSharedEnvKey = false;
  if (reg.requireAgentIdentity == null) reg.requireAgentIdentity = true;
  saveRegistry(reg);
  return reg.agents[agentId];
}
