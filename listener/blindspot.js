/**
 * blindspot.js -- covers the listener's #p-gating BLIND SPOT.
 *
 * WHY THIS EXISTS
 * ---------------
 * subscribe.js can only ever see messages that carry a #p tag addressed to us:
 * the relay REJECTS an un-p-gated `{kinds:[9]}` REQ with
 *   "restricted: p-gated events require #p matching your pubkey".
 *
 * But not every client attaches that tag. The Buzz phone client sends plain
 * kind-9 messages tagged only with the channel ("h"), even when the user types
 * the agent's name or uses reply. Those messages are stored by the relay, are
 * visible to every human in the channel, and are INVISIBLE to the listener.
 * Measured on this deployment: 25 of 97 messages over 14 days had no #p tag.
 *
 * The Buzz HTTP API (`buzz messages get`) is NOT p-gated -- it authenticates as
 * a channel member and returns everything. So we poll that, cheaply, and feed
 * anything the subscription cannot see into the SAME handler pipeline.
 *
 *     subscribe.js  --(p-tagged events)------> handler.js --> responder
 *     blindspot.js  --(un-p-tagged events)---/
 *
 * NO DOUBLE REPLIES, BY CONSTRUCTION
 * ----------------------------------
 * The two sources handle provably disjoint sets:
 *   - subscription: message HAS #p:<us>   (the relay guarantees this)
 *   - blindspot:    message has NO #p:<us> (we filter for it here)
 * A message cannot be in both. Belt-and-braces, handler.js also dedupes on
 * event.id, so even if the sets ever overlapped the second copy is dropped.
 *
 * COST: `buzz messages get` measured at ~26ms. At the default 3s cadence that
 * is <1% duty cycle, and execFile is async so the event loop is never blocked
 * (unlike responder.js, which uses spawnSync deliberately during a send).
 *
 * This module does NOT talk to the LLM or send anything -- it only produces
 * events. All reply policy stays in handler.js / responder.js.
 */

import { execFile } from 'child_process';

const DEFAULTS = {
  intervalMs: 3000,        // match subscribe.js fast-poll cadence
  lookback: 20,            // messages fetched per channel per scan
  channelListTtlMs: 300000, // re-list channels every 5 min
  replyMode: 'dms_only',   // 'dms_only' | 'all_channels'
  cliTimeoutMs: 15000,
};

/** Does this message carry a #p tag addressed to `pubkey`? */
export function hasPTagFor(msg, pubkey) {
  if (!pubkey || !Array.isArray(msg?.tags)) return false;
  return msg.tags.some((t) => Array.isArray(t) && t[0] === 'p' && t[1] === pubkey);
}

/**
 * Is this a 1:1 room? Judged by NAME only -- deliberately independent of
 * replyMode, because callers use it to decide whether requireMention applies.
 * In a 1:1 DM every message is addressed to us; in a busy multi-party channel
 * it is not.
 */
export function isOneToOneRoom(ch) {
  const name = (ch?.name || '').toLowerCase();
  return name === 'dm' || name.startsWith('dm ') || name.includes('direct');
}

/** Which channels should the scanner watch? */
export function isTargetChannel(ch, replyMode) {
  if (replyMode === 'all_channels') return true;
  return isOneToOneRoom(ch);
}

export class BlindspotScanner {
  /**
   * @param {object} opts
   * @param {string}   opts.buzzBin
   * @param {string}   opts.privateKey
   * @param {string}   [opts.relayUrl]
   * @param {string}   opts.selfPubkey        our x-only pubkey hex
   * @param {Function} opts.onEvent           (event, ctx) => void  -- feed handler.ingest
   * @param {Function} [opts.log]
   * @param {object}   [opts.tuning]          override DEFAULTS
   */
  constructor(opts) {
    if (!opts?.buzzBin) throw new Error('blindspot: buzzBin required');
    if (!opts?.privateKey) throw new Error('blindspot: privateKey required');
    if (!opts?.selfPubkey) throw new Error('blindspot: selfPubkey required');
    if (typeof opts.onEvent !== 'function') throw new Error('blindspot: onEvent required');

    this.buzzBin = opts.buzzBin;
    this.privateKey = opts.privateKey;
    this.relayUrl = opts.relayUrl;
    this.selfPubkey = opts.selfPubkey;
    this.onEvent = opts.onEvent;
    this._log = opts.log || (() => {});
    this.cfg = { ...DEFAULTS, ...(opts.tuning || {}) };

    this._timer = null;
    this._scanning = false;      // guards against overlapping scans
    this._channels = null;       // cached channel list
    this._channelsAt = 0;
    this._cursors = new Map();   // channelId -> { lastCreatedAt, lastEventId, seenIds:Set }
    this._seeded = false;        // false => first scan only records, never replies
    this._stats = { scans: 0, emitted: 0, skippedPTag: 0, errors: 0 };
  }

  // -------------------------------------------------------------------------
  // State persistence (index.js owns the file; we just serialise)
  // -------------------------------------------------------------------------
  seedState(s) {
    if (!s || typeof s !== 'object') return;
    this._seeded = !!s.seeded;
    for (const [chId, c] of Object.entries(s.channels || {})) {
      this._cursors.set(chId, {
        lastCreatedAt: c.lastCreatedAt || 0,
        lastEventId: c.lastEventId || null,
        seenIds: new Set(c.seenIds || []),
      });
    }
  }

  getState() {
    const channels = {};
    for (const [chId, c] of this._cursors.entries()) {
      channels[chId] = {
        lastCreatedAt: c.lastCreatedAt,
        lastEventId: c.lastEventId,
        seenIds: [...c.seenIds].slice(-80),
      };
    }
    return { seeded: this._seeded, channels, stats: this._stats };
  }

  get stats() { return { ...this._stats }; }

  // -------------------------------------------------------------------------
  start() {
    if (this._timer) return;
    this._log(
      'blindspot: scanning every ' + this.cfg.intervalMs + 'ms (lookback=' +
      this.cfg.lookback + ', replyMode=' + this.cfg.replyMode +
      ', seeded=' + this._seeded + ')'
    );
    this._timer = setInterval(() => { this._tick(); }, this.cfg.intervalMs);
    // NOTE: deliberately NOT unref'd -- same reasoning as the index.js watchdog.
    this._tick();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // -------------------------------------------------------------------------
  async _tick() {
    if (this._scanning) return; // previous scan still running -- skip this beat
    this._scanning = true;
    try {
      this._stats.scans += 1;
      const channels = await this._listChannels();
      const targets = channels.filter((ch) => isTargetChannel(ch, this.cfg.replyMode));
      for (const ch of targets) {
        await this._scanChannel(ch);
      }
      if (!this._seeded) {
        this._seeded = true;
        this._log('blindspot: initial seed complete -- existing backlog marked seen, no replies sent');
      }
    } catch (err) {
      this._stats.errors += 1;
      this._log('blindspot: scan error (non-fatal): ' + (err?.message || String(err)));
    } finally {
      this._scanning = false;
    }
  }

  async _listChannels() {
    const fresh = this._channels && (Date.now() - this._channelsAt) < this.cfg.channelListTtlMs;
    if (fresh) return this._channels;
    const out = await this._runBuzz(['channels', 'list']);
    const parsed = this._parseJson(out, null);
    if (!Array.isArray(parsed)) throw new Error('channels list did not return an array');
    this._channels = parsed;
    this._channelsAt = Date.now();
    return parsed;
  }

  async _scanChannel(ch) {
    const chId = ch.channel_id;
    if (!chId) return;
    const chName = ch.name || chId.slice(0, 8);

    const out = await this._runBuzz([
      'messages', 'get', '--channel', chId, '--limit', String(this.cfg.lookback),
    ]);
    const msgs = this._parseJson(out, null);
    if (!Array.isArray(msgs) || msgs.length === 0) return;

    const sorted = [...msgs].sort((a, b) => (a.created_at || 0) - (b.created_at || 0));
    const newest = sorted[sorted.length - 1];

    let cur = this._cursors.get(chId);
    if (!cur) {
      cur = { lastCreatedAt: 0, lastEventId: null, seenIds: new Set() };
      this._cursors.set(chId, cur);
    }

    // FIRST EVER SCAN (no persisted state): record everything, reply to nothing.
    // Without this a fresh install would answer the entire channel history.
    if (!this._seeded) {
      for (const m of sorted) if (m.id) cur.seenIds.add(m.id);
      cur.lastCreatedAt = newest.created_at || 0;
      cur.lastEventId = newest.id || null;
      this._trim(cur);
      this._log('blindspot: seed ' + JSON.stringify(chName) + ' -- ' + sorted.length + ' msgs marked seen');
      return;
    }

    const candidates = sorted.filter((m) => {
      if (!m?.id) return false;
      if (m.pubkey === this.selfPubkey) return false;          // our own replies
      if (cur.seenIds.has(m.id)) return false;                 // already processed
      if ((m.created_at || 0) < cur.lastCreatedAt) return false;
      // THE CORE FILTER: anything p-tagged for us belongs to subscribe.js.
      if (hasPTagFor(m, this.selfPubkey)) { this._stats.skippedPTag += 1; return false; }
      return true;
    });

    // Always advance the cursor, even when nothing is actionable, so the
    // watermark tracks the channel instead of drifting behind forever.
    cur.lastCreatedAt = Math.max(cur.lastCreatedAt, newest.created_at || 0);
    cur.lastEventId = newest.id || cur.lastEventId;

    if (candidates.length === 0) {
      for (const m of sorted) if (m.id) cur.seenIds.add(m.id);
      this._trim(cur);
      return;
    }

    // Mark every candidate seen NOW -- before emitting -- so a slow reply can
    // never cause the same message to be picked up again on the next beat.
    for (const m of candidates) cur.seenIds.add(m.id);
    for (const m of sorted) if (m.id) cur.seenIds.add(m.id);
    this._trim(cur);

    // Reply to the NEWEST unhandled message only. Older ones are context, not
    // separate questions -- this mirrors handler.js's per-author debounce and
    // stops a restart-after-downtime from firing a burst of replies.
    const target = candidates[candidates.length - 1];
    if (candidates.length > 1) {
      this._log(
        'blindspot: ' + candidates.length + ' unseen msgs in ' + JSON.stringify(chName) +
        ' -- replying to the newest only, ' + (candidates.length - 1) + ' older marked seen'
      );
    }

    this._stats.emitted += 1;
    this._log(
      'blindspot: un-p-tagged msg in ' + JSON.stringify(chName) + ' from ' +
      String(target.pubkey || '').slice(0, 8) + ' :: ' +
      JSON.stringify(String(target.content || '').slice(0, 60))
    );

    // `buzz messages get` already returns a Nostr-shaped object
    // ({id, pubkey, kind, content, created_at, tags}), so it can go straight
    // into the handler with no translation.
    this.onEvent(target, {
      live: true,
      source: 'blindspot',
      isOneToOne: isOneToOneRoom(ch),
      channelName: chName,
    });
  }

  _trim(cur) {
    if (cur.seenIds.size > 200) {
      cur.seenIds = new Set([...cur.seenIds].slice(-120));
    }
  }

  // -------------------------------------------------------------------------
  _runBuzz(args) {
    const env = {
      ...process.env,
      BUZZ_PRIVATE_KEY: this.privateKey,
      ...(this.relayUrl ? { BUZZ_RELAY_URL: this.relayUrl } : {}),
    };
    return new Promise((resolve, reject) => {
      execFile(
        this.buzzBin, args,
        { env, encoding: 'utf8', timeout: this.cfg.cliTimeoutMs, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) return reject(new Error('buzz ' + args.slice(0, 2).join(' ') + ': ' + (stderr || err.message).slice(0, 200)));
          resolve(stdout || '');
        }
      );
    });
  }

  _parseJson(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }
}

export default BlindspotScanner;
