/**
 * sidechannel.js -- closed-loop helper for "focused work in a side-channel,
 * summarized back to the original thread".
 *
 * Pattern (see skills/buzz-sidechannel/SKILL.md):
 *   1. open()          -> create a temporary side-channel for the work
 *   2. post()/postDiff() -> do the work there (as noisy as you like)
 *   3. summarizeBack() -> post a concise summary to the ORIGINAL thread with
 *                         replyTo set to the triggering event id
 *   4. close()         -> leave a cleanup/pointer marker in the side-channel
 *
 * This shells the same `buzz` CLI the plugin tools use, so it works anywhere the
 * listener runs. Every method returns a structured, agent-friendly result.
 */

import { spawnSync } from 'child_process';

function classify(exit) {
  switch (exit) {
    case 0: return { category: 'ok', retryable: false, hint: null };
    case 1: return { category: 'user_input', retryable: false, hint: 'Check arguments/UUIDs.' };
    case 2: return { category: 'network', retryable: true, hint: 'Relay unreachable. Check BUZZ_RELAY_URL (public hostname vs localhost / Host header).' };
    case 3: return { category: 'auth', retryable: false, hint: 'Auth/key problem; ensure the key is a relay member.' };
    case 5: return { category: 'write_conflict', retryable: true, hint: 'Concurrent write — retry.' };
    default: return { category: 'other', retryable: false, hint: 'See stderr.' };
  }
}

export class SideChannel {
  /**
   * @param {object} opts
   * @param {string} opts.buzzBin      path to the buzz binary
   * @param {string} opts.privateKey   BUZZ_PRIVATE_KEY for the CLI
   * @param {string} opts.relayUrl     BUZZ_RELAY_URL for the CLI
   * @param {Function} [opts.log]
   */
  constructor(opts = {}) {
    this.buzzBin = opts.buzzBin || 'buzz';
    this.privateKey = opts.privateKey;
    this.relayUrl = opts.relayUrl;
    this._log = opts.log || (() => {});
  }

  /** Create a focused side-channel. Returns { success, channelId, name }. */
  async open({ topic, about } = {}) {
    const slug = String(topic || 'work')
      .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'work';
    const name = `work-${slug}-${Math.random().toString(36).slice(2, 6)}`;
    const args = ['channels', 'create', '--name', name];
    if (about) args.push('--description', String(about));
    const r = this._run(args);
    if (r.exit !== 0) return this._err('open side-channel', r);
    const body = this._json(r.stdout, {});
    const channelId = body.channel_id || body.id || body.channelId;
    this._log('sidechannel: opened ' + name + ' (' + (channelId || '?') + ')');
    return { success: true, channelId, name };
  }

  /** Post a message into a channel. Returns { success, eventId }. */
  async post(channelId, content, replyTo) {
    if (!channelId || !content) return { success: false, error: 'channelId and content required', errorCategory: 'user_input' };
    const args = ['messages', 'send', '--channel', String(channelId), '--content', String(content)];
    if (replyTo) args.push('--reply-to', String(replyTo));
    const r = this._run(args);
    if (r.exit !== 0) return this._err('post', r);
    const body = this._json(r.stdout, {});
    return { success: true, eventId: body.event_id || body.id || null };
  }

  /** Post a code diff into a channel (wraps buzz messages send-diff). */
  async postDiff(channelId, { repo, commit, diff, file, description, replyTo } = {}) {
    if (!channelId || !diff || !repo || !commit) {
      return { success: false, error: 'channelId, diff, repo, commit required', errorCategory: 'user_input' };
    }
    const args = ['messages', 'send-diff', '--channel', String(channelId), '--diff', String(diff), '--repo', String(repo), '--commit', String(commit)];
    if (file) args.push('--file', String(file));
    if (description) args.push('--description', String(description));
    if (replyTo) args.push('--reply-to', String(replyTo));
    const r = this._run(args);
    if (r.exit !== 0) return this._err('postDiff', r);
    const body = this._json(r.stdout, {});
    return { success: true, eventId: body.event_id || body.id || null };
  }

  /**
   * Close the loop: post a concise summary back to the ORIGINAL thread with
   * replyTo set to the triggering event id. This is the important step.
   */
  async summarizeBack({ originalChannel, replyTo, summary } = {}) {
    if (!originalChannel || !summary) {
      return { success: false, error: 'originalChannel and summary required', errorCategory: 'user_input' };
    }
    const res = await this.post(originalChannel, summary, replyTo);
    if (res.success) this._log('sidechannel: summarized back to ' + originalChannel + (replyTo ? ' (replyTo ' + String(replyTo).slice(0, 10) + ')' : ''));
    return res;
  }

  /** Leave a cleanup / pointer marker in the side-channel. */
  async close(channelId, note) {
    return this.post(channelId, note || 'Done — archived. Summary posted in the main thread.');
  }

  // -------------------------------------------------------------------------
  _run(args) {
    const env = {
      ...process.env,
      ...(this.privateKey ? { BUZZ_PRIVATE_KEY: this.privateKey } : {}),
      ...(this.relayUrl ? { BUZZ_RELAY_URL: this.relayUrl } : {}),
    };
    const r = spawnSync(this.buzzBin, args, { env, encoding: 'utf8', timeout: 30000 });
    return { exit: r.status === null ? 4 : r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
  }

  _err(op, r) {
    const info = classify(r.exit);
    return {
      success: false,
      error: `${op} failed (exit ${r.exit}): ${(r.stderr || r.stdout || '').slice(0, 160)}`,
      errorCategory: info.category,
      hint: info.hint,
      retryable: info.retryable,
      exitCode: r.exit,
    };
  }

  _json(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }
}

export default SideChannel;
