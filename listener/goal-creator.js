/**
 * goal-creator.js -- turns a reply-intent into a rich, actionable AGNT Goal.
 *
 * This is the "goal" reply path (see index.js replyMode). Instead of (or in
 * addition to) a quick streaming reply, a relevant @mention / #p-tagged message
 * creates an AGNT Goal that fully briefs an autonomous agent so it can do real
 * work and then post the answer back into the SAME Buzz thread.
 *
 * The Goal contains:
 *   - a clear, short title (summary of the request)
 *   - the full original message content
 *   - channel id + channel name (resolved via the buzz CLI when possible)
 *   - the original event id (for replyTo) and the thread root (if a reply)
 *   - author pubkey + display name, and the timestamp
 *   - the last 8-12 messages of the channel as conversation context
 *   - an explicit instruction to reply in the same Buzz thread using
 *     buzz-send-message with replyTo set to the original event id
 *
 * Flow: POST /goals/create -> POST /goals/:id/execute-autonomous.
 *
 * RESILIENCE: if the AGNT backend is temporarily unavailable, the request is
 * queued and retried with exponential backoff. All other listener behavior
 * (dedupe/debounce/backlog-guard/reconnect) is unaffected -- this module only
 * consumes finished intents.
 */

import { spawnSync } from 'child_process';

const DEFAULTS = {
  agntApi: 'http://localhost:3333/api',
  contextMessages: 12, // fetch last N channel messages for context (8-12)
  maxIterations: 12, // autonomous execution budget per goal
  priority: 'high',
  provider: undefined, // let the goal use the user's default unless set
  model: undefined,
  // retry queue (AGNT backend temporarily down)
  maxRetries: 5,
  baseBackoffMs: 2000,
  maxBackoffMs: 60000,
  agentName: 'the agent', // used in instructions / title
  requestTimeoutMs: 20000,
  // Option B: the LISTENER owns the post-back. After launching the goal, poll it
  // to completion, extract the final answer, and post it to the Buzz thread
  // ourselves (we have working relay creds). This removes the dependency on the
  // autonomous agent having Buzz tools/credentials.
  postBack: true,
  pollIntervalMs: 5000,
  pollMaxMs: 240000, // give up polling after 4 min
  maxReplyLen: 3500,
};

export class GoalCreator {
  /**
   * @param {object} opts
   * @param {string} opts.agntApi
   * @param {string} opts.agntToken          bearer token for AGNT
   * @param {string} opts.buzzBin            buzz binary (for channel context + name)
   * @param {string} opts.privateKey         BUZZ_PRIVATE_KEY for the CLI
   * @param {string} opts.relayUrl           BUZZ_RELAY_URL for the CLI
   * @param {Function} [opts.log]
   * @param {object}   [opts.tuning]         override DEFAULTS
   */
  constructor(opts) {
    if (!opts?.agntToken) throw new Error('goal-creator: agntToken required');
    this.agntToken = opts.agntToken;
    this.buzzBin = opts.buzzBin || 'buzz';
    this.privateKey = opts.privateKey;
    this.relayUrl = opts.relayUrl;
    this._log = opts.log || (() => {});
    this.cfg = { ...DEFAULTS, ...(opts.tuning || {}) };
    this.agntApi = opts.agntApi || this.cfg.agntApi;

    this._queue = []; // pending { intent, attempt } waiting on backend
    this._draining = false;
    this._channelNameCache = new Map();
  }

  /** Public entry: create a Goal for this intent (queues + retries on failure). */
  async createGoal(intent) {
    try {
      await this._attempt(intent, 0);
    } catch (err) {
      this._log('goal-creator: initial attempt failed (' + err.message + ') -> queueing for retry');
      this._enqueue(intent, 1);
    }
  }

  // -------------------------------------------------------------------------
  async _attempt(intent, attempt) {
    // 1. resolve channel name + fetch recent channel context (best-effort)
    const channelName = this._resolveChannelName(intent.channelId);
    const contextMsgs = this._fetchChannelContext(intent.channelId, this.cfg.contextMessages);

    // 2. build the rich Goal title + description
    const { title, description } = this._buildGoal(intent, channelName, contextMsgs);

    // 3. create the goal
    const created = await this._post('/goals/create', {
      title,
      description,
      priority: this.cfg.priority,
      config: {
        source: 'buzz-listener',
        buzz: {
          channelId: intent.channelId,
          channelName,
          replyToEventId: intent.eventId,
          threadRoot: intent.threadRoot || null,
          authorPubkey: intent.authorPubkey,
          author: intent.author,
          mentionMethod: intent.mentionMethod,
        },
      },
    });
    // The /goals/create response nests the id as goal.goalId (not goal.id).
    // Support all observed shapes defensively.
    const goalId =
      created?.goal?.goalId ||
      created?.goal?.id ||
      created?.goalId ||
      created?.id ||
      created?.data?.goal?.goalId ||
      created?.data?.goalId;
    if (!goalId) throw new Error('no goal id in create response');
    this._log('goal-creator: created goal ' + goalId + ' "' + title.slice(0, 48) + '"');

    // 4. launch autonomous execution
    await this._post('/goals/' + goalId + '/execute-autonomous', {
      maxIterations: this.cfg.maxIterations,
      ...(this.cfg.provider ? { provider: this.cfg.provider } : {}),
      ...(this.cfg.model ? { model: this.cfg.model } : {}),
    });
    this._log('goal-creator: launched autonomous execution for goal ' + goalId);

    // 5. Option B: poll to completion + post the answer back ourselves (the
    //    listener has working Buzz creds; the autonomous agent may not). Runs in
    //    the background so createGoal() returns promptly.
    if (this.cfg.postBack) {
      this._pollAndPostBack(goalId, intent).catch((err) =>
        this._log('goal-creator: post-back error for ' + goalId + ': ' + err.message)
      );
    }
    return goalId;
  }

  // -------------------------------------------------------------------------
  // Option B: poll goal -> extract answer -> post back to the Buzz thread
  // -------------------------------------------------------------------------
  async _pollAndPostBack(goalId, intent) {
    const deadline = Date.now() + this.cfg.pollMaxMs;
    let goal = null;
    let ready = false;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, this.cfg.pollIntervalMs));
      let d;
      try {
        d = await this._get('/goals/' + goalId);
      } catch (err) {
        continue; // transient; keep polling
      }
      goal = d?.goal || d;
      const status = goal?.status;
      const tasks = Array.isArray(goal?.tasks) ? goal.tasks : [];
      const allTasksDone =
        tasks.length > 0 &&
        tasks.every((t) => ['completed', 'failed', 'skipped'].includes(t.status));
      // Post back as soon as the goal is terminal OR all tasks are done (the goal
      // status doesn't always flip to a terminal value even when tasks finish).
      if (['validated', 'completed', 'failed', 'needs_review'].includes(status) || allTasksDone) {
        ready = true;
        break;
      }
    }
    if (!goal || !ready) {
      this._log('goal-creator: goal ' + goalId + ' did not complete in time; no post-back');
      return;
    }

    const answer = this._extractAnswer(goal);
    if (!answer) {
      this._log('goal-creator: goal ' + goalId + ' produced no usable answer; no post-back');
      return;
    }

    // Post the answer back to the original thread using OUR working relay creds.
    const sent = this._runBuzz([
      'messages', 'send',
      '--channel', String(intent.channelId),
      '--content', answer.slice(0, this.cfg.maxReplyLen),
      ...(intent.eventId ? ['--reply-to', String(intent.eventId)] : []),
    ]);
    if (sent.exit === 0) {
      this._log('goal-creator: posted goal answer to ' + intent.channelId.slice(0, 8) +
        ' (replyTo=' + String(intent.eventId).slice(0, 10) + ', len=' + answer.length + ')');
    } else {
      this._log('goal-creator: post-back send failed exit=' + sent.exit + ': ' + (sent.stderr || sent.stdout).slice(0, 120));
    }
  }

  /**
   * Pull the final answer text out of a completed goal. Prefers an explicit
   * final/output field; falls back to the last non-error task output. Skips
   * API-error placeholders and sanitizes leaked reasoning.
   */
  _extractAnswer(goal) {
    const candidates = [];
    // explicit final result fields, if the API provides them
    if (typeof goal?.result === 'string') candidates.push(goal.result);
    if (typeof goal?.final_output === 'string') candidates.push(goal.final_output);
    if (typeof goal?.summary === 'string') candidates.push(goal.summary);

    // Task outputs. The LAST task is often "post the reply" whose output is the
    // agent's tool-fumbling narration (not the answer). The DRAFT/compose task
    // usually holds the real content. So we score candidates: prefer ones that
    // look like a substantive answer over tool/narration noise.
    const tasks = Array.isArray(goal?.tasks) ? goal.tasks : [];
    for (const t of tasks) {
      const raw = this._taskText(t.output);
      if (raw) candidates.push(raw);
    }

    const scored = candidates
      .map((c) => this._sanitize(c))
      .filter((c) => c && !this._isApiError(c) && !this._isToolNoise(c))
      .map((c) => ({ c, score: this._answerScore(c) }))
      .sort((a, b) => b.score - a.score);

    return scored.length ? this._cleanDraftScaffold(scored[0].c) : null;
  }

  // Narration/tool-plumbing text that is NOT the actual answer.
  _isToolNoise(text) {
    return /Writing a small script|JS executor|ESM import|toolExecutions|file_operations|run the plugin tool|reading the file/i.test(text);
  }

  // Higher = more likely the real answer (has substance, not just a status note).
  _answerScore(text) {
    let s = text.length;
    if (/Task complete|^\*\*/.test(text)) s -= 40; // status-y preamble
    if (/relay|http|summary|here (are|is)|tradeoff|\n- |\n\d\./i.test(text)) s += 120;
    if (text.length < 20) s -= 200;
    return s;
  }

  // Strip common status/markdown scaffolding to get to the message body.
  _cleanDraftScaffold(text) {
    // pull the quoted draft ("> ...") if present
    const quoted = text.split('\n').filter((l) => l.trim().startsWith('>')).map((l) => l.replace(/^\s*>\s?/, '')).join('\n').trim();
    if (quoted && quoted.length > 20) return quoted;
    return text;
  }

  _taskText(output) {
    if (!output) return '';
    if (typeof output === 'string') {
      // AGNT task outputs are often JSON like {content:[{type:'text',text:'...'}]}
      try {
        const o = JSON.parse(output);
        return this._taskText(o);
      } catch {
        return output;
      }
    }
    if (Array.isArray(output?.content)) {
      return output.content.map((c) => (typeof c?.text === 'string' ? c.text : '')).join('\n').trim();
    }
    if (typeof output?.text === 'string') return output.text;
    if (typeof output?.content === 'string') return output.content;
    return '';
  }

  _isApiError(text) {
    return /API Error|invalid_request_error|\b4\d\d\b.*error|usage.*limit/i.test(text);
  }

  _sanitize(raw) {
    let text = (raw || '').trim();
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/<think>[\s\S]*$/i, '').trim();
    // strip a leaked reasoning preamble
    text = text.replace(/^(the (user|human) (wants|asked|says)|okay|let me|i (need|should|will|'?ll)|as the agent|reply as|thinking:)[\s\S]*?(?:reply[:\-]\s*|response[:\-]\s*|:\s*\n)/i, '').trim();
    if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
      text = text.slice(1, -1).trim();
    }
    return text;
  }

  async _get(pathPart) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    try {
      const res = await fetch(this.agntApi + pathPart, {
        headers: { Authorization: 'Bearer ' + this.agntToken },
        signal: controller.signal,
      });
      clearTimeout(to);
      const text = await res.text().catch(() => '');
      if (!res.ok) throw new Error('GET ' + pathPart + ' -> ' + res.status);
      try { return JSON.parse(text); } catch { return {}; }
    } catch (err) {
      clearTimeout(to);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Goal content
  // -------------------------------------------------------------------------
  _buildGoal(intent, channelName, contextMsgs) {
    const when = new Date((intent.createdAt || Math.floor(Date.now() / 1000)) * 1000).toISOString();
    const chanLabel = channelName ? `#${channelName}` : intent.channelId;

    // short title: first line / clause of the request, trimmed
    const firstLine = (intent.content || '').split('\n')[0].trim();
    const shortReq = firstLine.length > 80 ? firstLine.slice(0, 77) + '…' : firstLine;
    const title = `Buzz: reply to ${intent.author} in ${chanLabel} — ${shortReq || 'new message'}`.slice(0, 140);

    const contextBlock = (contextMsgs || [])
      .map((m) => `- ${m.author}: ${m.content}`)
      .join('\n') || '(no earlier messages)';

    const description = [
      `You have received a message in Buzz (a Nostr-based team workspace) that is addressed to you (${this.cfg.agentName}).`,
      `Do the work the message asks for, then reply in the SAME Buzz thread.`,
      ``,
      `## The request`,
      intent.content,
      ``,
      `## Message metadata`,
      `- Channel: ${chanLabel}`,
      `- Channel ID: ${intent.channelId}`,
      `- Original event ID (use as replyTo): ${intent.eventId}`,
      intent.threadRoot ? `- Thread root event ID: ${intent.threadRoot}` : `- Thread: this is a top-level message (not a reply)`,
      `- From: ${intent.author} (pubkey ${intent.authorPubkey})`,
      `- Detected via: ${intent.mentionMethod}`,
      `- Timestamp: ${when}`,
      ``,
      `## Recent channel context (most recent last)`,
      contextBlock,
      ``,
      `## How to respond (IMPORTANT)`,
      `- When you are done, reply in the same Buzz thread using the buzz-send-message tool.`,
      `- Set the tool's "channel" to: ${intent.channelId}`,
      `- Set the tool's "replyTo" to the original event ID: ${intent.eventId}`,
      `- Keep the reply focused and useful. Include a short summary of what you did.`,
      `- If the task is large, you may create a side-channel to work in, then post a summary back to this thread with replyTo set as above.`,
      `- Do NOT reveal private keys or internal reasoning; post only the final message text.`,
    ].join('\n');

    return { title, description };
  }

  // -------------------------------------------------------------------------
  // Buzz CLI helpers (channel name + context)
  // -------------------------------------------------------------------------
  _resolveChannelName(channelId) {
    if (!channelId || channelId.startsWith('dm:')) return channelId?.startsWith('dm:') ? 'DM' : undefined;
    if (this._channelNameCache.has(channelId)) return this._channelNameCache.get(channelId);
    const r = this._runBuzz(['channels', 'list']);
    let name;
    if (r.exit === 0) {
      const arr = this._parseJson(r.stdout, []);
      const list = Array.isArray(arr) ? arr : arr?.channels || [];
      const hit = list.find((c) => (c.channel_id || c.id) === channelId);
      if (hit) name = hit.name;
    }
    this._channelNameCache.set(channelId, name);
    return name;
  }

  _fetchChannelContext(channelId, limit) {
    if (!channelId || channelId.startsWith('dm:')) return [];
    const r = this._runBuzz(['messages', 'get', '--channel', String(channelId), '--limit', String(limit)]);
    if (r.exit !== 0) {
      this._log('goal-creator: context fetch failed (exit ' + r.exit + '); proceeding without it');
      return [];
    }
    const arr = this._parseJson(r.stdout, []);
    const list = Array.isArray(arr) ? arr : arr?.messages || arr?.items || [];
    return list
      .filter((m) => typeof m.content === 'string' && m.content.trim())
      .slice(-limit)
      .map((m) => ({
        author: (m.pubkey || '').slice(0, 8) || 'user',
        content: m.content.slice(0, 500),
      }));
  }

  // -------------------------------------------------------------------------
  // Retry queue with exponential backoff (AGNT backend temporarily down)
  // -------------------------------------------------------------------------
  _enqueue(intent, attempt) {
    if (attempt > this.cfg.maxRetries) {
      this._log('goal-creator: giving up on goal for event ' + intent.eventId + ' after ' + this.cfg.maxRetries + ' retries');
      return;
    }
    this._queue.push({ intent, attempt });
    this._scheduleDrain();
  }

  _scheduleDrain() {
    if (this._draining) return;
    this._draining = true;
    const next = this._queue[0];
    const delay = Math.min(
      this.cfg.maxBackoffMs,
      this.cfg.baseBackoffMs * Math.pow(2, (next?.attempt || 1) - 1)
    );
    this._log('goal-creator: retrying queued goal(s) in ' + delay + 'ms (queue=' + this._queue.length + ')');
    const t = setTimeout(() => this._drain(), delay);
    t.unref?.();
  }

  async _drain() {
    this._draining = false;
    const item = this._queue.shift();
    if (!item) return;
    try {
      await this._attempt(item.intent, item.attempt);
    } catch (err) {
      this._log('goal-creator: retry ' + item.attempt + ' failed (' + err.message + ')');
      this._enqueue(item.intent, item.attempt + 1);
    }
    if (this._queue.length) this._scheduleDrain();
  }

  // -------------------------------------------------------------------------
  async _post(pathPart, body) {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), this.cfg.requestTimeoutMs);
    let res;
    try {
      res = await fetch(this.agntApi + pathPart, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          Authorization: 'Bearer ' + this.agntToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body || {}),
      });
    } catch (err) {
      clearTimeout(to);
      // network error -> treat as retryable
      throw new Error('AGNT unreachable: ' + err.message);
    }
    clearTimeout(to);
    const text = await res.text().catch(() => '');
    if (!res.ok) {
      // 5xx / connection resets -> retryable; 4xx -> still throw (caller queues,
      // but maxRetries bounds it). We surface status for logging.
      throw new Error('AGNT ' + pathPart + ' -> ' + res.status + ': ' + text.slice(0, 160));
    }
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  }

  _runBuzz(args) {
    const env = {
      ...process.env,
      ...(this.privateKey ? { BUZZ_PRIVATE_KEY: this.privateKey } : {}),
      ...(this.relayUrl ? { BUZZ_RELAY_URL: this.relayUrl } : {}),
    };
    const r = spawnSync(this.buzzBin, args, { env, encoding: 'utf8', timeout: 20000 });
    return {
      exit: r.status === null ? 4 : r.status,
      stdout: r.stdout || '',
      stderr: r.stderr || '',
    };
  }

  _parseJson(s, fallback) {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  }
}

export default GoalCreator;
