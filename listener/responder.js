/**
 * responder.js -- reply generation for the Buzz listener.
 *
 * SINGLE-SEND design (no placeholder, no edit-to-replace):
 *   1. Generate the COMPLETE answer from AGNT's /orchestrator/chat SSE endpoint
 *      (consumed fully; the SSE is still parsed the poller's way so reasoning
 *      never leaks and text never doubles).
 *   2. Send it EXACTLY ONCE, threaded to the original message (reply-to).
 *   3. On generation failure or an empty answer, send NOTHING.
 *
 * Why not the old placeholder-then-edit "typing" effect: posting a "…" first and
 * editing it into the answer left an orphaned "…" whenever the edit didn't land
 * (backend blip, exit-5 write conflict, provider hiccup) -- the root cause of the
 * repeated "ack, then silence" failures. Single-send either delivers a complete
 * answer or nothing; it never leaves a dangling placeholder.
 *
 * Reuses the poller's proven patterns: the AGNT SSE body shape, the buzz CLI
 * spawn, exit-code semantics.
 */

import { spawnSync } from 'child_process';
import crypto from 'crypto';

const DEFAULTS = {
  editIntervalMs: 450, // min gap between edits (relay-friendly)
  minCharsPerEdit: 12, // don't edit for tiny deltas
  placeholder: '…',
  maxReplyLen: 4000,
  llmProvider: 'GrokAI',
  llmModel: 'grok-4.5',
  requestTimeoutMs: 60000,
};

// Default persona. Override via config.systemPrompt (passed as tuning.systemPrompt).
// {CHANNEL} is replaced with "DM" or "channel".
const DEFAULT_SYSTEM_PROMPT = `You are a helpful Buzz teammate (an AGNT agent). Reply in-character to a {CHANNEL} message.
Rules:
- Reply ONLY with the message text to post (no quotes, no name prefix, no tool calls).
- Be brief (1-4 short sentences) unless they ask for depth.
- Be warm and useful.
- Never reveal private keys.
- If they just say hi, greet back and offer help.`;

// Ack persona for 'auto' mode: a short acknowledgement while a background Goal
// does the real work and posts the full answer as a follow-up.
const ACK_SYSTEM_PROMPT = `You are a helpful Buzz teammate (an AGNT agent). The user sent a request that you are now working on in the background.
Reply with ONE short sentence acknowledging the request and saying you're on it — no more.
Rules:
- Reply ONLY with the message text (no quotes, no name prefix, no tool calls).
- 1 short sentence, warm and specific to their ask if possible.
- Do NOT attempt to answer the request itself here.`;

export class Responder {
  /**
   * @param {object} opts
   * @param {string} opts.buzzBin        path to the buzz binary
   * @param {string} opts.privateKey     nsec/hex for the buzz CLI (BUZZ_PRIVATE_KEY)
   * @param {string} opts.relayUrl       BUZZ_RELAY_URL for the CLI
   * @param {string} opts.agntApi        e.g. http://localhost:3333/api
   * @param {string} opts.agntToken      bearer token for AGNT
   * @param {Function} [opts.log]
   * @param {object}   [opts.tuning]
   */
  constructor(opts) {
    if (!opts?.buzzBin) throw new Error('responder: buzzBin required');
    if (!opts?.privateKey) throw new Error('responder: privateKey required');
    if (!opts?.agntToken) throw new Error('responder: agntToken required');
    this.buzzBin = opts.buzzBin;
    this.privateKey = opts.privateKey;
    this.relayUrl = opts.relayUrl;
    this.agntApi = opts.agntApi || 'http://localhost:3333/api';
    this.agntToken = opts.agntToken;
    this._log = opts.log || (() => {});
    this.cfg = { ...DEFAULTS, ...(opts.tuning || {}) };
    this._busy = new Set(); // channelIds currently being answered (avoid overlap)
  }

  /** Handle one reply-intent from handler.js. Returns a promise. */
  async respond(intent) {
    if (this._busy.has(intent.channelId)) {
      this._log('responder: busy on ' + intent.channelId.slice(0, 8) + ', skipping overlap');
      return;
    }
    this._busy.add(intent.channelId);
    try {
      await this._respondInner(intent);
    } catch (err) {
      this._log('responder: error: ' + err.message);
    } finally {
      this._busy.delete(intent.channelId);
    }
  }

  async _respondInner(intent) {
    // SINGLE-SEND design (no placeholder, no edit-to-replace).
    //
    // The old placeholder-then-edit pattern posted a "…" first and then edited
    // it into the answer. When the edit didn't land (backend blip, exit-5 write
    // conflict, provider hiccup) it left an orphaned "…" and the real answer
    // either never appeared or came as a separate message. That was the root of
    // the repeated "ack, then silence" failures.
    //
    // Now: generate the COMPLETE answer first, then send it EXACTLY ONCE. If
    // generation fails, we send NOTHING (never a dangling "…"). No edits, no
    // placeholder, no orphans.
    let finalClean;
    try {
      finalClean = await this._streamFromAgnt(intent, () => {}); // no live edits
    } catch (err) {
      this._log('responder: generation failed (' + err.message + '); sending nothing (no orphan placeholder)');
      return;
    }

    const text = (finalClean || '').trim().slice(0, this.cfg.maxReplyLen);
    if (!text) {
      this._log('responder: empty answer; sending nothing');
      return;
    }

    // One clean send, threaded to the original message.
    const sent = this._sendWithRetry(intent, text);
    if (sent.exit === 0) {
      this._log('responder: replied (single-send) to ' + intent.author + ' len=' + text.length);
    } else {
      this._log('responder: send failed exit=' + sent.exit + ': ' + (sent.stderr || sent.stdout).slice(0, 120));
    }
  }

  /**
   * Send one message, threaded. Retries a couple of times on a transient
   * failure (exit 2 network / exit 5 write conflict) so a brief blip doesn't
   * drop the whole reply. Never posts a placeholder.
   */
  _sendWithRetry(intent, text, attempts = 3) {
    let last = { exit: 4, stdout: '', stderr: '' };
    for (let i = 0; i < attempts; i++) {
      last = this._runBuzz([
        'messages', 'send',
        '--channel', intent.channelId,
        '--content', text,
        ...(intent.eventId ? ['--reply-to', intent.eventId] : []),
      ]);
      if (last.exit === 0) return last;
      // only retry transient classes
      if (last.exit !== 2 && last.exit !== 5) return last;
      this._log('responder: send exit=' + last.exit + ' (transient), retry ' + (i + 1) + '/' + (attempts - 1));
      // small backoff
      const until = Date.now() + 800 * (i + 1);
      while (Date.now() < until) { /* spin-wait: keep it simple + synchronous with spawnSync */ }
    }
    return last;
  }

  // -------------------------------------------------------------------------
  // AGNT streaming (SSE) -- mirrors the poller's /orchestrator/chat call, but
  // surfaces token deltas to onDelta() as they arrive.
  // -------------------------------------------------------------------------
  async _streamFromAgnt(intent, onDelta) {
    const channelName = intent.channelId.startsWith('dm:') ? 'DM' : 'channel';
    const basePrompt = intent._ackOnly
      ? ACK_SYSTEM_PROMPT
      : (this.cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT);
    const systemish = basePrompt.replace('{CHANNEL}', channelName);
    const threadLines = (intent.thread || [])
      .slice(-8)
      .map((m) => m.author + ': ' + m.content)
      .join('\n');
    const userMsg =
      systemish +
      '\n\nRecent thread:\n' + (threadLines || '(empty)') +
      '\n\nNew message from ' + intent.author + ':\n' + intent.content +
      '\n\nYour reply:';

    const conversationId = 'annie-buzz-listener-' + crypto.randomBytes(6).toString('hex');
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);

    let res;
    try {
      res = await fetch(this.agntApi + '/orchestrator/chat', {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + this.agntToken,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify({
          message: userMsg,
          provider: this.cfg.llmProvider,
          model: this.cfg.llmModel,
          enabledTools: [],
          conversationId,
        }),
      });
    } finally {
      // keep timeout armed until stream completes below
    }

    if (!res.ok) {
      clearTimeout(to);
      const t = await res.text().catch(() => '');
      throw new Error('AGNT chat ' + res.status + ': ' + t.slice(0, 160));
    }

    // Parse AGNT's SSE the SAME way the (working) poller does. AGNT emits NAMED
    // events; treating every data: line as content is what leaked reasoning +
    // doubled the text. We track cumulative `finalContent` and surface deltas.
    //   content_delta { delta }       -> append
    //   content_delta { accumulated } -> REPLACE (cumulative snapshot)
    //   final_content                 -> authoritative final text
    //   error / done                  -> handled
    // Reasoning/thinking events are simply NOT content_delta, so they're ignored.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finalContent = '';
    let streamDone = false;

    const emitTo = (newFull) => {
      // surface only the NEW suffix as a delta so the edit-stream fills in;
      // if the snapshot isn't a superset, resync by emitting a replace signal.
      if (newFull.startsWith(finalContent)) {
        const d = newFull.slice(finalContent.length);
        finalContent = newFull;
        if (d) onDelta(d, finalContent);
      } else {
        finalContent = newFull;
        onDelta('', finalContent); // replace signal (empty delta, full snapshot)
      }
    };

    try {
      while (!streamDone) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          let event = 'message';
          let data = '';
          for (const line of part.split('\n')) {
            if (line.startsWith('event:')) event = line.slice(6).trim();
            else if (line.startsWith('data:')) data += (data ? '\n' : '') + line.slice(5).trimStart();
          }
          if (!data) continue;
          let parsed;
          try { parsed = JSON.parse(data); } catch { parsed = data; }

          if (event === 'content_delta') {
            if (typeof parsed?.delta === 'string') { finalContent += parsed.delta; onDelta(parsed.delta, finalContent); }
            else if (typeof parsed?.accumulated === 'string') emitTo(parsed.accumulated);
          } else if (event === 'final_content') {
            if (typeof parsed === 'string') emitTo(parsed);
            else if (parsed?.content) emitTo(parsed.content);
            else if (parsed?.text) emitTo(parsed.text);
          } else if (event === 'error') {
            const err = typeof parsed === 'string' ? parsed : parsed?.error || JSON.stringify(parsed);
            throw new Error('LLM error: ' + err);
          } else if (event === 'done') {
            streamDone = true;
          }
          // any other event (reasoning/thinking/tool) is intentionally ignored
        }
      }
    } finally {
      clearTimeout(to);
    }

    // hand the fully-assembled, cleaned final text back to the caller
    return this.sanitizeReply(finalContent);
  }

  /**
   * Strip anything that shouldn't be posted: <think> blocks, leaked reasoning
   * preambles, wrapping quotes. Belt-and-suspenders on top of event filtering.
   */
  sanitizeReply(raw) {
    let text = (raw || '').trim();
    // remove <think>...</think> (and unclosed) reasoning blocks
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
    // remove a leaked reasoning preamble like:
    // "The user wants me to reply as Annie ... The rules say: <actual reply>"
    const leakRe = /^(the (user|human) (wants|is|asked|says)|okay|let me|i (need|should|will|'?ll)|as annie|the rules say|reply as annie|i'?m going to|first,|thinking:)[\s\S]*?(?:rules say[:\-]?\s*|reply[:\-]\s*|response[:\-]\s*|:\s*\n)/i;
    if (leakRe.test(text)) text = text.replace(leakRe, '').trim();
    // de-duplicate an exact doubled reply: "XX" -> "X" (with or without a
    // separator between the halves). Handles the streaming-diff doubling.
    {
      const dedup = (s) => {
        const t = s.trim();
        if (t.length < 8) return t;
        // exact concatenation halves
        if (t.length % 2 === 0) {
          const h = t.slice(0, t.length / 2);
          if (h === t.slice(t.length / 2)) return h.trim();
        }
        // halves with optional whitespace between
        const m = t.match(/^([\s\S]{4,}?)\s*\1$/);
        if (m) return m[1].trim();
        return t;
      };
      text = dedup(text);
    }
    // strip wrapping quotes
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1).trim();
    }
    return text;
  }

  // -------------------------------------------------------------------------
  _runBuzz(args) {
    const env = {
      ...process.env,
      BUZZ_PRIVATE_KEY: this.privateKey,
      ...(this.relayUrl ? { BUZZ_RELAY_URL: this.relayUrl } : {}),
    };
    const r = spawnSync(this.buzzBin, args, { env, encoding: 'utf8', timeout: 20000 });
    return {
      exit: r.status === null ? 4 : r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
      error: r.error ? r.error.message : null,
    };
  }

  _parseJson(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }
}

export default Responder;
