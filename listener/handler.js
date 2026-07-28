/**
 * handler.js -- turns a raw stream of inbound Nostr EVENTs into clean,
 * de-duplicated, debounced "reply intents".
 *
 * Deliverable #2 (push/ack) support layer. Sits between subscribe.js and
 * responder.js:
 *
 *     subscribe.js  --(event)-->  handler.js  --(intent)-->  responder.js
 *
 * Responsibilities:
 *   - DEDUPE: never process the same event.id twice (LRU-capped Set) -- this is
 *     what makes reconnect gap-backfill idempotent.
 *   - SELF-FILTER: drop events authored by us (our own replies).
 *   - BACKLOG GUARD: during initial backlog replay ({live:false}) we record
 *     event ids as "seen" but do NOT reply -- otherwise a reconnect would
 *     re-answer old messages. Only live events (post-EOSE) trigger a reply.
 *   - DEBOUNCE per author: if someone fires several messages quickly, collapse
 *     them into ONE reply intent using the latest message + recent context.
 *   - CONTEXT: keep a small rolling thread window per channel for the reply.
 *
 * It does NOT talk to the relay, the LLM, or the CLI.
 */

const DEFAULTS = {
  dedupeCapacity: 5000, // max event ids remembered
  debounceMs: 1200, // collapse rapid same-author bursts
  threadWindow: 8, // messages of context to keep per channel
  maxContentLen: 4000, // ignore absurdly long payloads
};

/**
 * Map a pubkey to a friendly display name. Generic: the agent itself is "me",
 * everyone else is a short-form pubkey. (An optional aliases map could be added
 * later; kept minimal so the companion is workspace-agnostic.)
 */
export function knownAuthor(pubkey, selfPubkey) {
  if (!pubkey) return 'someone';
  if (pubkey === selfPubkey) return 'me';
  return 'user:' + pubkey.slice(0, 8);
}

export class Handler {
  /**
   * @param {object} opts
   * @param {string} opts.selfPubkey            our x-only pubkey hex (to skip our own events)
   * @param {(intent) => void} opts.onIntent    called when a live message deserves a reply
   * @param {Function} [opts.log]
   * @param {object}   [opts.tuning]            override DEFAULTS
   */
  constructor(opts) {
    if (!opts?.selfPubkey) throw new Error('handler: selfPubkey required');
    if (typeof opts.onIntent !== 'function') throw new Error('handler: onIntent required');
    this.selfPubkey = opts.selfPubkey;
    this.onIntent = opts.onIntent;
    this._log = opts.log || (() => {});
    this.cfg = { ...DEFAULTS, ...(opts.tuning || {}) };

    this._seen = new Set(); // event ids
    this._seenOrder = []; // for LRU eviction
    this._threads = new Map(); // channelId -> [{author, content, ts}]
    this._debounce = new Map(); // author -> { timer, pending }
  }

  /** Feed one event from subscribe.js. ctx.live=false during backlog replay. */
  ingest(event, ctx) {
    const live = !!(ctx && ctx.live);
    if (!event || !event.id) return;

    // dedupe
    if (this._seen.has(event.id)) return;
    this._remember(event.id);

    // skip our own events
    if (event.pubkey === this.selfPubkey) return;

    // only care about chat messages (kind 9) for replies; still record others as context
    const content = typeof event.content === 'string' ? event.content : '';
    if (content.length > this.cfg.maxContentLen) return;

    const channelId = this._channelOf(event);
    const author = knownAuthor(event.pubkey, this.selfPubkey);

    // maintain rolling thread context for this channel
    if (event.kind === 9 && content.trim()) {
      this._pushThread(channelId, { author, content, ts: event.created_at });
    }

    // Backlog (pre-EOSE): record context + seen, but do NOT reply.
    if (!live) return;

    // Only kind-9 text messages produce a reply intent.
    if (event.kind !== 9 || !content.trim()) return;

    this._debounceReply(event, { channelId, author, content });
  }

  // -------------------------------------------------------------------------
  _debounceReply(event, meta) {
    const key = event.pubkey;
    const existing = this._debounce.get(key);
    if (existing) clearTimeout(existing.timer);

    const pending = { event, meta };
    const timer = setTimeout(() => {
      this._debounce.delete(key);
      this._emitIntent(pending);
    }, this.cfg.debounceMs);

    this._debounce.set(key, { timer, pending });
  }

  _emitIntent(pending) {
    const { event, meta } = pending;
    const intent = {
      eventId: event.id,
      channelId: meta.channelId,
      author: meta.author,
      authorPubkey: event.pubkey,
      content: meta.content,
      createdAt: event.created_at,
      thread: this._threadSnapshot(meta.channelId),
      rawEvent: event,
    };
    this._log(
      'handler: intent from ' + intent.author + ' in ' + (intent.channelId || '?').slice(0, 8) +
        ' :: ' + JSON.stringify(intent.content.slice(0, 60))
    );
    try {
      this.onIntent(intent);
    } catch (err) {
      this._log('handler: onIntent threw: ' + err.message);
    }
  }

  // -------------------------------------------------------------------------
  // helpers
  // -------------------------------------------------------------------------
  _channelOf(event) {
    // Buzz channel id lives in an 'h' tag (NIP-29 group / channel id).
    // Fall back to a 'e' root or the author pubkey so DMs still group.
    const tags = Array.isArray(event.tags) ? event.tags : [];
    const h = tags.find((t) => t[0] === 'h');
    if (h && h[1]) return h[1];
    const e = tags.find((t) => t[0] === 'e');
    if (e && e[1]) return e[1];
    return 'dm:' + (event.pubkey || 'unknown').slice(0, 16);
  }

  _pushThread(channelId, entry) {
    let arr = this._threads.get(channelId);
    if (!arr) {
      arr = [];
      this._threads.set(channelId, arr);
    }
    arr.push(entry);
    if (arr.length > this.cfg.threadWindow) arr.splice(0, arr.length - this.cfg.threadWindow);
  }

  _threadSnapshot(channelId) {
    const arr = this._threads.get(channelId) || [];
    return arr.slice(-this.cfg.threadWindow).map((m) => ({ author: m.author, content: m.content }));
  }

  _remember(id) {
    this._seen.add(id);
    this._seenOrder.push(id);
    if (this._seenOrder.length > this.cfg.dedupeCapacity) {
      const evict = this._seenOrder.shift();
      this._seen.delete(evict);
    }
  }
}

export default Handler;
