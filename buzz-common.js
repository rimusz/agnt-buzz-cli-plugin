/**
 * Shared Buzz CLI runner for AGNT tools.
 *
 * Wraps the official `buzz` binary (JSON in / JSON out).
 * Auth: per-agent Nostr key via ~/.agnt/buzz-identities (see buzz-identity.js).
 * Relay: BUZZ_RELAY_URL. Shared BUZZ_PRIVATE_KEY disabled by default.
 *
 * Exit codes (from buzz-cli): 0=ok, 1=user, 2=network, 3=auth, 4=other, 5=write conflict
 */

import { spawn } from 'child_process';
import { accessSync, constants as fsConstants } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveIdentity } from './buzz-identity.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Exit-code -> structured, agent-friendly categorization.
//   category: machine-readable class
//   hint:     actionable guidance for the agent
//   retryable: whether a transient retry makes sense
export const EXIT_INFO = {
  0: { category: 'ok', hint: null, retryable: false },
  1: {
    category: 'user_input',
    hint: 'Input/validation error. Check arguments, UUIDs, and required fields.',
    retryable: false,
  },
  2: {
    category: 'network',
    hint:
      'Relay unreachable, timed out, or host/origin mismatch. Check BUZZ_RELAY_URL — it must be the PUBLIC hostname that opens Buzz from THIS machine (NOT localhost/127.0.0.1 if the relay enforces its origin/Host header). Verify the relay is running and network-reachable.',
    retryable: true,
  },
  3: {
    category: 'auth',
    hint:
      'Authentication/key problem. Check BUZZ_PRIVATE_KEY / the per-agent identity, that the key is valid, and that the key is a MEMBER of the relay (closed relays require add-member).',
    retryable: false,
  },
  4: { category: 'other', hint: 'Unexpected CLI/relay error. Inspect stderr for details.', retryable: false },
  5: { category: 'write_conflict', hint: 'Concurrent write/edit conflict — retry the operation.', retryable: true },
};

// Back-compat: short one-line hint per exit code (used in error message text).
const EXIT_HINTS = Object.fromEntries(
  Object.entries(EXIT_INFO)
    .filter(([code]) => Number(code) !== 0)
    .map(([code, info]) => [Number(code), info.hint])
);

/** Look up the structured category/hint/retryable for a CLI exit code. */
export function classifyExit(code) {
  return EXIT_INFO[code] || { category: 'other', hint: EXIT_INFO[4].hint, retryable: false };
}

/**
 * Resolve path to the `buzz` binary.
 *
 * Runtime order (plugin):
 *   1. explicit tool/workflow param (`buzzBin`)
 *   2. process.env.BUZZ_BIN
 *   3. process.env.BUZZ_CLI_PATH
 *   4. bare name "buzz" (spawn uses PATH)
 *
 * Ops/discover (skills, shell) may also try fixed fallbacks after PATH:
 *   ~/.cargo/bin/buzz, Homebrew, /usr/local/bin, ~/.local/bin
 * This function does NOT scan those paths — set BUZZ_BIN under LaunchAgent.
 *
 * Canonical docs: docs/ARCHITECTURE.md § CLI binary resolution
 */
export function resolveBuzzBin(explicit) {
  const candidates = [
    explicit,
    process.env.BUZZ_BIN,
    process.env.BUZZ_CLI_PATH,
    'buzz',
  ].filter(Boolean);

  for (const c of candidates) {
    if (c === 'buzz' || !c.includes('/') && !c.includes('\\')) {
      // bare name — leave to PATH; spawn will fail clearly if missing
      if (c === 'buzz') return 'buzz';
    }
    try {
      accessSync(c, fsConstants.X_OK);
      return c;
    } catch {
      // try next
    }
  }
  return 'buzz';
}

/**
 * Build env for a Buzz CLI invocation.
 *
 * Identity policy (default): per-agent only — see buzz-identity.js.
 * Order: explicit privateKey param → agent registry → shared env (if allowed).
 * Inherited process.env.BUZZ_PRIVATE_KEY is stripped unless the registry allows it
 * or an explicit/agent key was resolved.
 */
export function buildEnv(params = {}) {
  const env = { ...process.env };
  const resolved = resolveIdentity(params, params.__inputData || {}, params.__workflowEngine || null);

  // Never inherit a shared host key unless identity resolver intentionally returned it
  delete env.BUZZ_PRIVATE_KEY;

  if (!resolved.ok || !resolved.privateKey) {
    env.__BUZZ_IDENTITY_ERROR = resolved.error || 'No Buzz identity resolved';
    env.__BUZZ_IDENTITY_SOURCE = resolved.source || 'none';
    if (resolved.agentId) env.__BUZZ_AGENT_ID = resolved.agentId;
    env.NO_COLOR = env.NO_COLOR || '1';
    return {
      env,
      hasKey: false,
      identityError: resolved.error || 'No Buzz identity resolved',
      identity: resolved,
    };
  }

  env.BUZZ_PRIVATE_KEY = String(resolved.privateKey).trim();
  const relayUrl = resolved.relayUrl || params.relayUrl || params.buzzRelayUrl || process.env.BUZZ_RELAY_URL;
  if (relayUrl) env.BUZZ_RELAY_URL = String(relayUrl).trim();
  env.NO_COLOR = env.NO_COLOR || '1';
  if (resolved.agentId) env.__BUZZ_AGENT_ID = resolved.agentId;
  env.__BUZZ_IDENTITY_SOURCE = resolved.source || 'unknown';

  return {
    env,
    hasKey: true,
    identityError: null,
    identity: resolved,
  };
}

function tryParseJson(text) {
  if (text == null) return null;
  const s = String(text).trim();
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    // Some commands may print multiple JSON lines or trailing logs — try last {...} block
    const start = s.indexOf('{');
    const startArr = s.indexOf('[');
    let i = -1;
    if (start === -1) i = startArr;
    else if (startArr === -1) i = start;
    else i = Math.min(start, startArr);
    if (i >= 0) {
      try {
        return JSON.parse(s.slice(i));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Run `buzz <args...>` and return a structured result.
 *
 * @param {string[]} args CLI args after the binary name
 * @param {object} options
 * @param {object} [options.params] tool params (privateKey, relayUrl, buzzBin, timeoutMs)
 * @param {string|Buffer} [options.stdin] optional stdin body (for --content - / --diff -)
 * @param {number} [options.timeoutMs] default 60000
 */
export function runBuzz(args, options = {}) {
  const params = options.params || {};
  const timeoutMs = Number(params.timeoutMs || options.timeoutMs || 60000);
  const bin = resolveBuzzBin(params.buzzBin || options.buzzBin);
  const { env, hasKey, identityError, identity } = buildEnv(params);

  return new Promise((resolve) => {
    if (!hasKey) {
      resolve({
        success: false,
        error:
          identityError ||
          'No per-agent Buzz identity. Register one under ~/.agnt/buzz-identities/ (see plugin docs PER-AGENT-IDENTITY.md). Shared BUZZ_PRIVATE_KEY is disabled by default.',
        exitCode: 3,
        stdout: '',
        stderr: '',
        data: null,
        identitySource: identity?.source || 'none',
        agentId: identity?.agentId || null,
      });
      return;
    }

    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };

    let child;
    try {
      child = spawn(bin, args, {
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        shell: false,
      });
    } catch (err) {
      finish({
        success: false,
        error: `Failed to spawn Buzz CLI (${bin}): ${err.message}. Install buzz-cli (cargo install --path crates/buzz-cli) and ensure it is on PATH, or set BUZZ_BIN.`,
        exitCode: null,
        stdout: '',
        stderr: err.message,
        data: null,
        binary: bin,
      });
      return;
    }

    let stdout = '';
    let stderr = '';

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      finish({
        success: false,
        error: `Buzz CLI timed out after ${timeoutMs}ms (command: ${bin} ${args.join(' ')})`,
        exitCode: null,
        stdout,
        stderr,
        data: tryParseJson(stdout),
        binary: bin,
        timedOut: true,
      });
    }, timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf8');
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      const missing = err.code === 'ENOENT';
      finish({
        success: false,
        error: missing
          ? `Buzz CLI binary not found (${bin}). Install from https://github.com/block/buzz (crates/buzz-cli) and set BUZZ_BIN if needed.`
          : `Buzz CLI process error: ${err.message}`,
        exitCode: null,
        stdout,
        stderr: stderr || err.message,
        data: null,
        binary: bin,
      });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const data = tryParseJson(stdout);
      const errJson = tryParseJson(stderr);
      const ok = code === 0;

      let error = null;
      if (!ok) {
        if (errJson?.message) {
          error = `Buzz CLI error (${errJson.error || EXIT_HINTS[code] || `exit ${code}`}): ${errJson.message}`;
        } else if (stderr.trim()) {
          error = `Buzz CLI failed (exit ${code}${EXIT_HINTS[code] ? `: ${EXIT_HINTS[code]}` : ''}): ${stderr.trim().slice(0, 800)}`;
        } else if (data?.error || data?.message) {
          error = `Buzz CLI failed (exit ${code}): ${data.message || data.error}`;
        } else {
          error = `Buzz CLI failed with exit code ${code}${EXIT_HINTS[code] ? ` (${EXIT_HINTS[code]})` : ''}. Command: ${bin} ${args.join(' ')}`;
        }
      }

      finish({
        success: ok,
        error,
        exitCode: code,
        stdout,
        stderr,
        data: data !== null ? data : ok ? stdout.trim() : null,
        raw: stdout.trim() || null,
        binary: bin,
        args,
      });
    });

    // stdin
    try {
      if (options.stdin != null) {
        child.stdin.write(typeof options.stdin === 'string' ? options.stdin : options.stdin);
      }
      child.stdin.end();
    } catch {
      /* ignore broken pipe if process already exited */
    }
  });
}

/**
 * Normalize tool params: merge workflow inputData shallowly for common fields.
 */
export function mergeParams(params = {}, inputData = {}, workflowEngine = null) {
  const merged = { ...(params || {}) };
  // Fill blanks from inputData (workflow chaining)
  if (inputData && typeof inputData === 'object') {
    for (const key of Object.keys(inputData)) {
      if ((merged[key] === undefined || merged[key] === null || merged[key] === '') && inputData[key] != null) {
        merged[key] = inputData[key];
      }
    }
  }
  // Stash context for identity resolution inside buildEnv/runBuzz
  merged.__inputData = inputData || {};
  merged.__workflowEngine = workflowEngine || null;
  // Promote agentId from workflow engine when missing
  if (!merged.agentId && workflowEngine) {
    const id =
      workflowEngine.agentId ||
      workflowEngine.agent_id ||
      workflowEngine.agent?.id ||
      workflowEngine.context?.agentId ||
      null;
    if (id && id !== 'orchestrator' && id !== 'agent-chat') {
      merged.agentId = id;
    }
  }
  return merged;
}

export function requireFields(params, fields) {
  const missing = fields.filter((f) => params[f] === undefined || params[f] === null || params[f] === '');
  if (missing.length) {
    return `Missing required field(s): ${missing.join(', ')}`;
  }
  return null;
}

export function successResult(result, extras = {}) {
  return {
    success: true,
    result,
    data: result,
    error: null,
    ...extras,
  };
}

/**
 * Build a structured, agent-friendly error result.
 *
 * When called with { exitCode } (as every tool does after a failed runBuzz),
 * it enriches the result with a machine-readable `errorCategory`, an actionable
 * `hint`, and a `retryable` flag derived from the CLI exit code. This is how
 * exit-code semantics (esp. exit 2 = network / relay-URL guidance) propagate to
 * every tool uniformly.
 */
export function errorResult(error, extras = {}) {
  const message = typeof error === 'string' ? error : error?.message || String(error);
  const out = {
    success: false,
    result: null,
    data: null,
    error: message,
    ...extras,
  };

  // Enrich from the exit code when present (and not already provided).
  if (out.exitCode !== undefined && out.exitCode !== null) {
    const info = classifyExit(out.exitCode);
    if (out.errorCategory === undefined) out.errorCategory = info.category;
    if (out.hint === undefined && info.hint) out.hint = info.hint;
    if (out.retryable === undefined) out.retryable = !!info.retryable;
  } else if (out.errorCategory === undefined) {
    out.errorCategory = 'error';
  }
  return out;
}

export { __dirname };
