/**
 * responder.js -- Deliverable #1: STREAMING replies.
 *
 * Consumes a reply-intent from handler.js and produces a live "typing" effect in
 * Buzz by:
 *   1. Immediately sending a placeholder message ("...") via `buzz messages send`
 *      (reply-to the triggering event, so it threads correctly).
 *   2. Streaming tokens from AGNT's /orchestrator/chat SSE endpoint (same call the
 *      poller used, but consumed incrementally).
 *   3. Throttle-editing the placeholder (`buzz messages edit`) every ~editIntervalMs
 *      with the accumulated text -> the message visibly fills in.
 *   4. One final edit with the complete reply.
 *
 * Fallback: if `messages edit` errors (e.g. write conflict / rate limit, exit 5),
 * we stop editing and just do a single final send-or-edit at the end (Option B).
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
    // 1. placeholder send (threaded reply)
    const sent = this._runBuzz([
      'messages', 'send',
      '--channel', intent.channelId,
      '--content', this.cfg.placeholder,
      ...(intent.eventId ? ['--reply-to', intent.eventId] : []),
    ]);
    if (sent.exit !== 0) {
      this._log('responder: placeholder send failed: ' + (sent.stderr || sent.stdout));
      return;
    }
    const sentBody = this._parseJson(sent.stdout, {});
    const msgEventId = sentBody.event_id || sentBody.id || null;
    if (!msgEventId) {
      this._log('responder: no event_id from send; falling back to single-shot');
      return this._singleShot(intent);
    }

    // 2. stream + throttle-edit. onDelta gives (delta, fullSnapshot); we edit
    //    with the SANITIZED cumulative snapshot so the fill-in never shows
    //    leaked reasoning, and never doubles.
    let lastEditText = this.cfg.placeholder;
    let lastEditAt = 0;
    let editingDisabled = false;

    const flushEdit = (snapshot, force) => {
      if (editingDisabled) return;
      const clean = this.sanitizeReply(snapshot).slice(0, this.cfg.maxReplyLen);
      if (!clean.trim() || clean === lastEditText) return;
      const now = Date.now();
      const grew = clean.length - lastEditText.length;
      const dueByTime = now - lastEditAt >= this.cfg.editIntervalMs;
      const dueBySize = grew >= this.cfg.minCharsPerEdit;
      if (!force && !(dueByTime && dueBySize)) return;
      const ed = this._runBuzz([
        'messages', 'edit',
        '--event', msgEventId,
        '--content', clean,
      ]);
      if (ed.exit !== 0) {
        this._log('responder: edit exit=' + ed.exit + ' -> disabling live edits (' + (ed.stderr || '').slice(0, 80) + ')');
        editingDisabled = true;
        return;
      }
      lastEditText = clean;
      lastEditAt = now;
    };

    // _streamFromAgnt returns the fully-assembled SANITIZED final text.
    const finalClean = await this._streamFromAgnt(intent, (delta, snapshot) => {
      flushEdit(snapshot, false);
    });

    // 3. final edit with the authoritative sanitized reply
    const finalText = (finalClean || 'On it.').slice(0, this.cfg.maxReplyLen);
    const finalEd = this._runBuzz([
      'messages', 'edit',
      '--event', msgEventId,
      '--content', finalText,
    ]);
    if (finalEd.exit !== 0) {
      this._log('responder: final edit failed exit=' + finalEd.exit + ': ' + (finalEd.stderr || finalEd.stdout));
    } else {
      this._log('responder: replied (streamed) to ' + intent.author + ' len=' + finalText.length);
    }
  }

  /** Option B fallback: generate fully, then one send. */
  async _singleShot(intent) {
    const finalClean = await this._streamFromAgnt(intent, () => {});
    const text = (finalClean || 'On it.').slice(0, this.cfg.maxReplyLen);
    const sent = this._runBuzz([
      'messages', 'send',
      '--channel', intent.channelId,
      '--content', text,
      ...(intent.eventId ? ['--reply-to', intent.eventId] : []),
    ]);
    this._log('responder: single-shot ' + (sent.exit === 0 ? 'ok' : 'FAIL ' + sent.stderr));
  }

  // -------------------------------------------------------------------------
  // AGNT streaming (SSE) -- mirrors the poller's /orchestrator/chat call, but
  // surfaces token deltas to onDelta() as they arrive.
  // -------------------------------------------------------------------------
  async _streamFromAgnt(intent, onDelta) {
    const channelName = intent.channelId.startsWith('dm:') ? 'DM' : 'channel';
    const systemish = (this.cfg.systemPrompt || DEFAULT_SYSTEM_PROMPT).replace('{CHANNEL}', channelName);
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
