/**
 * handler.js -- turns a raw stream of inbound Nostr EVENTs into clean,
 * de-duplicated, debounced "reply intents".
 *
 * Sits between subscribe.js and the reply layer (responder.js / goal-creator.js):
 *
 *     subscribe.js  --(event)-->  handler.js  --(intent)-->  responder | goal-creator
 *
 * Responsibilities:
 *   - DEDUPE: never process the same event.id twice (LRU-capped Set) -- this is
 *     what makes reconnect gap-backfill idempotent.
 *   - SELF-FILTER: drop events authored by us (our own replies).
 *   - BACKLOG GUARD: during initial backlog replay ({live:false}) we record
 *     event ids as "seen" but do NOT reply -- otherwise a reconnect would
 *     re-answer old messages. Only live events (post-EOSE) trigger a reply.
 *   - MENTION DETECTION: an intent fires when the message is addressed to the
 *     agent, via EITHER a #p tag pointing at us, OR a plain-text mention of the
 *     agent's name / aliases (case-insensitive). The trigger method is recorded
 *     on the intent (`mentionMethod`) and logged.
 *   - DEBOUNCE per author: if someone fires several messages quickly, collapse
 *     them into ONE reply intent using the latest message + recent context.
 *   - CONTEXT: keep a small rolling thread window per channel for the reply, and
 *     surface the thread-root event id so the reply layer can attach full
 *     channel context / thread continuity.
 *
 * It does NOT talk to the relay, the LLM, or the CLI.
 */

const DEFAULTS = {
  dedupeCapacity: 5000, // max event ids remembered
  debounceMs: 1200, // collapse rapid same-author bursts
  threadWindow: 8, // messages of context to keep per channel
  maxContentLen: 4000, // ignore absurdly long payloads
  // Mention detection:
  //   agentName      -> primary display name to match in plain text (optional)
  //   agentAliases   -> extra names/handles to match (optional array)
  //   requireMention -> if true, ONLY reply when a #p tag or name mention is
  //                     present. If false, any #p-gated inbound message replies
  //                     (legacy behavior — the relay already p-gates delivery).
  agentName: '',
  agentAliases: [],
  requireMention: false,
};

/**
 * Map a pubkey to a friendly display name. Generic: the agent itself is "me",
 * everyone else is a short-form pubkey. A per-pubkey alias map can be supplied
 * via tuning.authorAliases ({ pubkeyHex: "Name" }) to give nicer names.
 */
export function knownAuthor(pubkey, selfPubkey, authorAliases) {
  if (!pubkey) return 'someone';
  if (pubkey === selfPubkey) return 'me';
  if (authorAliases && authorAliases[pubkey]) return authorAliases[pubkey];
  return 'user:' + pubkey.slice(0, 8);
}

export class Handler {
  /**
   * @param {object} opts
   * @param {string} opts.selfPubkey            our x-only pubkey hex (to skip our own events)
   * @param {(intent) => void} opts.onIntent    called when a live message deserves a reply
   * @param {Function} [opts.log]
   * @param {object}   [opts.tuning]            override DEFAULTS (agentName, agentAliases, requireMention, authorAliases, ...)
   */
  constructor(opts) {
    if (!opts?.selfPubkey) throw new Error('handler: selfPubkey required');
    if (typeof opts.onIntent !== 'function') throw new Error('handler: onIntent required');
    this.selfPubkey = opts.selfPubkey;
    this.onIntent = opts.onIntent;
    this._log = opts.log || (() => {});
    this.cfg = { ...DEFAULTS, ...(opts.tuning || {}) };
    this.authorAliases = this.cfg.authorAliases || {};

    // Precompute a lowercase set of mention tokens (name + aliases), non-empty.
    this._mentionTokens = [this.cfg.agentName, ...(this.cfg.agentAliases || [])]
      .filter((s) => typeof s === 'string' && s.trim().length >= 2)
      .map((s) => s.trim().toLowerCase());

    this._seen = new Set(); // event ids
    this._seenOrder = []; // for LRU eviction
    this._threads = new Map(); // channelId -> [{author, content, ts, id}]
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
    const author = knownAuthor(event.pubkey, this.selfPubkey, this.authorAliases);

    // maintain rolling thread context for this channel
    if (event.kind === 9 && content.trim()) {
      this._pushThread(channelId, { author, content, ts: event.created_at, id: event.id });
    }

    // Backlog (pre-EOSE): record context + seen, but do NOT reply.
    if (!live) return;

    // Only kind-9 text messages produce a reply intent.
    if (event.kind !== 9 || !content.trim()) return;

    // Mention detection: how (if at all) is this addressed to us?
    const mentionMethod = this._detectMention(event, content);
    if (this.cfg.requireMention && mentionMethod === 'none') {
      // configured to only answer explicit mentions -> ignore ambient chatter
      return;
    }

    this._debounceReply(event, { channelId, author, content, mentionMethod });
  }

  // -------------------------------------------------------------------------
  // Mention detection
  // -------------------------------------------------------------------------
  /**
   * Returns 'p-tag' | 'name-mention' | 'p-tag+name' | 'none'.
   * - p-tag: a #p tag points at our pubkey (Buzz-app DMs/@mentions carry this)
   * - name-mention: the message text contains our name/alias (case-insensitive)
   */
  _detectMention(event, content) {
    let byTag = false;
    const tags = Array.isArray(event.tags) ? event.tags : [];
    for (const t of tags) {
      if (t[0] === 'p' && t[1] === this.selfPubkey) {
        byTag = true;
        break;
      }
    }
    let byName = false;
    if (this._mentionTokens.length) {
      const lc = content.toLowerCase();
      byName = this._mentionTokens.some((tok) => {
        // word-ish boundary match: token surrounded by start/end or non-word char,
        // and also match a leading '@name'
        const i = lc.indexOf(tok);
        if (i === -1) return false;
        const before = i === 0 ? '' : lc[i - 1];
        const after = i + tok.length >= lc.length ? '' : lc[i + tok.length];
        const boundaryOk = (c) => c === '' || !/[a-z0-9]/.test(c);
        return boundaryOk(before) && boundaryOk(after);
      });
    }
    if (byTag && byName) return 'p-tag+name';
    if (byTag) return 'p-tag';
    if (byName) return 'name-mention';
    return 'none';
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
      channelName: undefined, // resolved by the reply layer (needs a CLI call)
      threadRoot: this._threadRootOf(event), // root event id if this is a reply, else undefined
      author: meta.author,
      authorPubkey: event.pubkey,
      content: meta.content,
      createdAt: event.created_at,
      mentionMethod: meta.mentionMethod, // 'p-tag' | 'name-mention' | 'p-tag+name' | 'none'
      thread: this._threadSnapshot(meta.channelId),
      rawEvent: event,
    };
    this._log(
      'handler: intent from ' + intent.author + ' in ' + (intent.channelId || '?').slice(0, 8) +
        ' via ' + intent.mentionMethod +
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

  /**
   * If this message is a reply, return the thread ROOT event id so the reply
   * layer can reconstruct the whole thread. Prefers an explicit ["e", id, "", "root"]
   * marker (NIP-10); falls back to the first 'e' tag; undefined if not a reply.
   */
  _threadRootOf(event) {
    const tags = Array.isArray(event.tags) ? event.tags : [];
    const eTags = tags.filter((t) => t[0] === 'e' && t[1]);
    if (!eTags.length) return undefined;
    const rootMarked = eTags.find((t) => t[3] === 'root');
    if (rootMarked) return rootMarked[1];
    // NIP-10 positional: first e-tag is the root when markers are absent
    return eTags[0][1];
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
    return arr.slice(-this.cfg.threadWindow).map((m) => ({ author: m.author, content: m.content, id: m.id }));
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
