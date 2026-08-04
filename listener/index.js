#!/usr/bin/env node
/**
 * index.js -- Buzz real-time listener entrypoint (opt-in companion).
 *
 * Makes an AGNT agent auto-respond to Buzz DMs/mentions in ~3s. Wires:
 *   RelaySocket (auth+reconnect) -> Subscription (FAST-POLL p-gated REQ) ->
 *   Handler (dedupe/debounce/mention-detection/context) -> reply layer.
 *
 * REPLY MODES (config.replyMode, default "auto"):
 *   "stream" -> streaming "typing" reply via /orchestrator/chat (fast, ~3s)
 *   "goal"   -> create a rich AGNT Goal + run it autonomously (deep work; the
 *               goal's agent posts the answer back via buzz-send-message)
 *   "auto"   -> send a quick streamed acknowledgement AND spin up a Goal for
 *               substantive requests (best of both). Trivial greetings just get
 *               the streamed reply, no goal.
 *
 * NOTE ON TRANSPORT: the Buzz relay uses a push/query model, not persistent
 * post-EOSE streaming, so subscribe.js POLLS via repeated short-lived REQ
 * queries (~3s). Only #p-tagged messages (real Buzz-app DMs/mentions to the
 * agent) are delivered — which is exactly the intended scope.
 *
 * Modes:
 *   (default)  full: subscribe + respond
 *   --observe  observe-only: log intents, send NOTHING (safe dry-run)
 *
 * Config resolution (first hit wins):
 *   1. env BUZZ_LISTENER_CONFIG
 *   2. ./config.json  (next to this file — what install-listener.sh writes)
 * Config keys: relayUrl, nsecPath (or env BUZZ_PRIVATE_KEY), agntApi,
 *   agntTokenPath (or env AGNT_AUTH_TOKEN), llmProvider, llmModel, buzzBin,
 *   pollIntervalMs (optional).
 * Paths ~ and $HOME are expanded.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import { RelaySocket } from './relay-socket.js';
import { Subscription } from './subscribe.js';
import { Handler } from './handler.js';
import { Responder } from './responder.js';
import { GoalCreator } from './goal-creator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OBSERVE = process.argv.includes('--observe');

function expand(p) {
  if (!p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p.replace(/\$HOME/g, os.homedir());
}

const CONFIG_PATH = expand(process.env.BUZZ_LISTENER_CONFIG) || expand(process.env.ANNIE_LISTENER_CONFIG) || path.join(__dirname, 'config.json');
const STATE_PATH = expand((process.env.BUZZ_LISTENER_STATE || process.env.ANNIE_LISTENER_STATE)) || path.join(__dirname, 'listener-state.json');
const LOG_PATH = expand((process.env.BUZZ_LISTENER_LOG || process.env.ANNIE_LISTENER_LOG)) || path.join(__dirname, 'listener.log');

function log(line) {
  const msg = '[' + new Date().toISOString() + '] ' + line;
  console.log(msg);
  try { fs.appendFileSync(LOG_PATH, msg + '\n'); } catch {}
}

function readJson(p, fallback = null) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function resolvePrivateKey(cfg) {
  if (process.env.BUZZ_PRIVATE_KEY?.trim()) return process.env.BUZZ_PRIVATE_KEY.trim();
  const p = expand(cfg.nsecPath);
  if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8').replace(/\s+/g, '');
  throw new Error('No BUZZ_PRIVATE_KEY env or cfg.nsecPath');
}

function resolveAgntToken(cfg) {
  if (process.env.AGNT_AUTH_TOKEN?.trim()) return process.env.AGNT_AUTH_TOKEN.trim();
  const p = expand(cfg.agntTokenPath);
  if (p && fs.existsSync(p)) return fs.readFileSync(p, 'utf8').trim();
  throw new Error('No AGNT_AUTH_TOKEN env or cfg.agntTokenPath');
}

const cfg = readJson(CONFIG_PATH);
if (!cfg) throw new Error('Missing config at ' + CONFIG_PATH + ' (run install-listener.sh)');
if (!cfg.relayUrl) throw new Error('config.relayUrl is required');

const privateKey = resolvePrivateKey(cfg);
const agntToken = resolveAgntToken(cfg);
const state = readJson(STATE_PATH, { sinceCursor: 0 });

log('listener starting mode=' + (OBSERVE ? 'OBSERVE-ONLY' : 'FULL') + ' relay=' + cfg.relayUrl);

const socket = new RelaySocket({ relayUrl: cfg.relayUrl, nsec: privateKey, log });

const REPLY_MODE = (cfg.replyMode || 'auto').toLowerCase(); // 'auto' | 'stream' | 'goal'
const buzzBin = expand(cfg.buzzBin) || 'buzz';
const agntApi = cfg.agntApi || 'http://localhost:3333/api';

// Streaming responder (used by 'stream' and the ack half of 'auto').
const responder = OBSERVE
  ? null
  : new Responder({
      buzzBin,
      privateKey,
      relayUrl: cfg.relayUrl,
      agntApi,
      agntToken,
      log,
      tuning: {
        llmProvider: cfg.llmProvider || 'GrokAI',
        llmModel: cfg.llmModel || 'grok-4.5',
        ...(cfg.systemPrompt ? { systemPrompt: cfg.systemPrompt } : {}),
      },
    });

// Goal creator (used by 'goal' and the deep-work half of 'auto').
const goalCreator = OBSERVE
  ? null
  : new GoalCreator({
      agntApi,
      agntToken,
      buzzBin,
      privateKey,
      relayUrl: cfg.relayUrl,
      log,
      tuning: {
        agentName: cfg.agentName || 'the agent',
        contextMessages: cfg.contextMessages || 12,
        maxIterations: cfg.goalMaxIterations || 12,
        ...(cfg.goalProvider ? { provider: cfg.goalProvider } : {}),
        ...(cfg.goalModel ? { model: cfg.goalModel } : {}),
      },
    });

// A request is "substantive" (worth a Goal) unless it's a trivial greeting/thanks.
const TRIVIAL_RE = /^(\s*(hi|hey|hello|yo|hiya|sup|thanks|thank you|ty|ok|okay|cool|nice|👍|🙏|👋)[\s!.,]*)+$/i;
function isSubstantive(content) {
  const c = (content || '').trim();
  if (c.length < 12) return false;
  if (TRIVIAL_RE.test(c)) return false;
  return true;
}

async function handleIntent(intent) {
  if (OBSERVE) {
    const sub = isSubstantive(intent.content);
    log('OBSERVE intent (' + intent.mentionMethod + ', mode=' + REPLY_MODE + ', substantive=' + sub +
      ') -> would ' + (REPLY_MODE === 'goal' || (REPLY_MODE === 'auto' && sub) ? 'create GOAL' : 'stream reply') +
      ' for ' + intent.author + ': ' + JSON.stringify(intent.content.slice(0, 80)));
    return;
  }
  try {
    if (REPLY_MODE === 'stream') {
      await responder.respond(intent);
    } else if (REPLY_MODE === 'goal') {
      await goalCreator.createGoal(intent);
    } else {
      // auto: substantive -> quick ack (stream) + goal; trivial -> just stream
      if (isSubstantive(intent.content)) {
        // fire the goal (deep work) and a short ack in parallel
        goalCreator.createGoal(intent);
        await responder.respond({ ...intent, _ackOnly: true });
      } else {
        await responder.respond(intent);
      }
    }
  } catch (err) {
    log('handleIntent error: ' + err.message);
  }
}

const handler = new Handler({
  selfPubkey: socket.pubkey,
  log,
  onIntent: (intent) => { handleIntent(intent); },
  tuning: {
    agentName: cfg.agentName || '',
    agentAliases: cfg.agentAliases || [],
    requireMention: cfg.requireMention === true,
    authorAliases: cfg.authorAliases || {},
  },
});

const sub = new Subscription({
  socket,
  log,
  pollIntervalMs: cfg.pollIntervalMs || 3000,
  onEvent: (event, ctx) => handler.ingest(event, ctx),
});
sub.seedSince(state.sinceCursor || 0);
sub.attach();

const persistTimer = setInterval(() => {
  try {
    fs.writeFileSync(STATE_PATH, JSON.stringify({ sinceCursor: sub.sinceCursor, updatedAt: new Date().toISOString() }, null, 2));
  } catch {}
}, 15000);
persistTimer.unref?.();

// Crash guard: RelaySocket emits 'error' on transient relay/WebSocket hiccups.
// Node throws (and kills the process) if an EventEmitter emits 'error' with no
// listener attached -- so a single relay blip would crash the whole listener.
// Swallow it here as non-fatal: RelaySocket already handles reconnect via
// exponential backoff, and a genuine sustained outage still surfaces via
// 'giveup' below (which exits for the supervisor to restart).
socket.on('error', (err) => {
  log('relay-socket error (non-fatal, reconnect handles recovery): ' + (err && err.message ? err.message : String(err)));
});
// Belt-and-suspenders: never let an unhandled async rejection or a stray
// synchronous throw from a callback tear the process down. Log and keep running.
process.on('unhandledRejection', (err) => {
  log('unhandledRejection (non-fatal): ' + (err && err.message ? err.message : String(err)));
});
process.on('uncaughtException', (err) => {
  log('uncaughtException (non-fatal): ' + (err && err.stack ? err.stack : (err && err.message ? err.message : String(err))));
});

socket.on('giveup', () => { log('listener: socket gave up reconnecting -- exiting for supervisor restart'); process.exit(1); });

// ---------------------------------------------------------------------------
// Liveness watchdog (BUGFIX -- 2026-08-04 outage).
//
// Two independent failure modes are covered here:
//
//   1. SILENT DRAIN. If every timer/handle is released (the old connect-timeout
//      bug did exactly that), Node's event loop empties and the process exits
//      with status 0 -- the one status launchd's KeepAlive/SuccessfulExit=false
//      rule deliberately ignores. This interval is intentionally NOT unref'd,
//      so the loop can never drain and the process can never vanish silently.
//
//   2. WEDGED-BUT-ALIVE. If the socket stays unauthenticated for longer than
//      staleAfterMs, the listener is deaf even though the process is up. Exit
//      non-zero so the supervisor restarts us into a clean state.
// ---------------------------------------------------------------------------
const STALE_AFTER_MS = Number(cfg.staleAfterMs || 300000);   // 5 min
const WATCHDOG_TICK_MS = Number(cfg.watchdogTickMs || 30000); // 30 s
let lastAuthedAt = Date.now();
socket.on('authed', () => { lastAuthedAt = Date.now(); });
setInterval(() => {
  if (socket.isAuthed()) { lastAuthedAt = Date.now(); return; }
  const staleMs = Date.now() - lastAuthedAt;
  if (staleMs >= STALE_AFTER_MS) {
    log('watchdog: not authenticated for ' + Math.round(staleMs / 1000) +
        's (limit ' + Math.round(STALE_AFTER_MS / 1000) + 's) -- exiting 1 for supervisor restart');
    process.exit(1);
  }
  log('watchdog: link down for ' + Math.round(staleMs / 1000) + 's (limit ' +
      Math.round(STALE_AFTER_MS / 1000) + 's)');
}, WATCHDOG_TICK_MS); // NOTE: deliberately not .unref()'d -- see (1) above.
process.on('SIGINT', () => { log('SIGINT'); socket.stopLink(); process.exit(0); });
process.on('SIGTERM', () => { log('SIGTERM'); socket.stopLink(); process.exit(0); });

socket.start();
