/**
 * subscribe.js -- FAST-POLL p-gated querying on top of RelaySocket.
 *
 * IMPORTANT: this relay does NOT stream live events. Its NIP-11 advertises
 * due_delivery_mode:"push" which is a push/query model (APNs-style for the
 * mobile app), NOT persistent post-EOSE WebSocket streaming. Proven empirically:
 * a REQ returns the stored backlog, sends EOSE, and then NOTHING new ever
 * arrives on the open subscription -- even for correctly #p-tagged events, which
 * ARE stored and retrievable by a *fresh* REQ.
 *
 * So instead of one long-lived subscription waiting for pushes, we POLL:
 * every `pollIntervalMs` we open a short-lived REQ with `since:<cursor>`,
 * collect the new EVENTs until EOSE, CLOSE the sub, advance the cursor, and
 * sleep. This gives ~pollIntervalMs latency (default 3s) over the same
 * authenticated socket -- far better than the 60s CLI poller.
 *
 * CURSOR / DEDUP: Nostr `since` is INCLUSIVE (created_at >= since), and several
 * events can share the same created_at second. So we cannot simply advance
 * since past the newest timestamp without risking dropping a same-second
 * sibling. Instead we:
 *   - keep `since = highestCreatedAt` (inclusive, so no same-second event is missed), and
 *   - keep a bounded set of already-emitted event ids to suppress the
 *     re-delivery of the boundary events on the next cycle.
 * (handler.js also dedups by id; this local set just avoids re-emitting and
 * keeps logs clean.)
 *
 * Public interface is UNCHANGED from the streaming version, so index.js /
 * handler.js / responder.js / relay-socket.js need no edits:
 *   - attach() / detach() / seedSince(ts) / get sinceCursor / isLive()
 *   - onEvent(event,{live}) -- live=false only during the first (backlog)
 *     cycle so handler.js's backlog-guard suppresses replies to old messages.
 *
 * Filter: {"#p":[ownPubkey], kinds:[9,7], since:<cursor>}. The #p is mandatory --
 * the relay rejects un-p-gated {kinds:[9]} with
 * "restricted: p-gated events require #p matching your pubkey".
 */

const DEFAULT_KINDS = [9, 7];
const SUB_ID = 'annie-poll';
const BACKFILL_SLACK_SECONDS = 5;
const SEEN_CAP = 2000; // bounded id-dedup memory

export class Subscription {
  /**
   * @param {object} opts
   * @param {RelaySocket} opts.socket
   * @param {(event, ctx) => void} opts.onEvent
   * @param {number[]} [opts.kinds]
   * @param {boolean}  [opts.includeDMs]
   * @param {number}   [opts.limit]           per-cycle max events (default 50)
   * @param {number}   [opts.pollIntervalMs]  gap between cycles (default 3000)
   * @param {number}   [opts.cycleTimeoutMs]  max wait for EOSE (default 8000)
   * @param {Function} [opts.log]
   */
  constructor(opts) {
    if (!opts?.socket) throw new Error('subscribe: socket required');
    if (typeof opts.onEvent !== 'function') throw new Error('subscribe: onEvent required');
    this.socket = opts.socket;
    this.onEvent = opts.onEvent;
    this.kinds = opts.kinds ? [...opts.kinds] : [...DEFAULT_KINDS];
    if (opts.includeDMs && !this.kinds.includes(1059)) this.kinds.push(1059);
    this.limit = opts.limit ?? 50;
    this.pollIntervalMs = opts.pollIntervalMs ?? 3000;
    this.cycleTimeoutMs = opts.cycleTimeoutMs ?? 8000;
    this._log = opts.log || (() => {});

    this._sinceCursor = 0;
    this._firstCycleDone = false;
    this._polling = false;
    this._stopped = false;
    this._cycleTimer = null;
    this._nextTimer = null;

    this._seen = new Set();   // event ids already emitted
    this._seenOrder = [];     // FIFO for bounded eviction

    this._onAuthed = this._startPolling.bind(this);
    this._onFrame = this._handleFrame.bind(this);
    this._onDropped = () => {
      this._polling = false;
      this._clearTimers();
    };
  }

  attach() {
    this.socket.on('authed', this._onAuthed);
    this.socket.on('frame', this._onFrame);
    this.socket.on('dropped', this._onDropped);
    if (this.socket.isAuthed()) this._startPolling();
    return this;
  }

  detach() {
    this._stopped = true;
    this._clearTimers();
    this.socket.off('authed', this._onAuthed);
    this.socket.off('frame', this._onFrame);
    this.socket.off('dropped', this._onDropped);
  }

  seedSince(createdAt) {
    if (typeof createdAt === 'number' && createdAt > this._sinceCursor) {
      this._sinceCursor = createdAt;
    }
  }

  get sinceCursor() {
    return this._sinceCursor;
  }

  isLive() {
    return this._firstCycleDone;
  }

  // -------------------------------------------------------------------------
  _startPolling() {
    if (this._stopped) return;
    this._log('subscribe: fast-poll started (every ' + this.pollIntervalMs + 'ms), since=' + this._sinceCursor);
    this._runCycle();
  }

  _buildFilter() {
    const filter = {
      '#p': [this.socket.pubkey],
      kinds: this.kinds,
      limit: this.limit,
    };
    if (this._sinceCursor > 0) {
      // inclusive since -> a bit of slack on the very first cycle for restarts;
      // steady-state uses the exact cursor and relies on id-dedup for boundary events.
      const slack = this._firstCycleDone ? 0 : BACKFILL_SLACK_SECONDS;
      filter.since = Math.max(0, this._sinceCursor - slack);
    }
    return filter;
  }

  _remember(id) {
    if (this._seen.has(id)) return false;
    this._seen.add(id);
    this._seenOrder.push(id);
    if (this._seenOrder.length > SEEN_CAP) {
      const evict = this._seenOrder.shift();
      this._seen.delete(evict);
    }
    return true;
  }

  _runCycle() {
    if (this._stopped || this._polling) return;
    if (!this.socket.isAuthed()) return;
    this._polling = true;
    const filter = this._buildFilter();
    const ok = this.socket.send(['REQ', SUB_ID, filter]);
    if (!ok) {
      this._polling = false;
      this._scheduleNext();
      return;
    }
    this._cycleTimer = setTimeout(() => {
      if (this._polling) {
        this._log('subscribe: cycle timeout, forcing next');
        this._endCycle();
      }
    }, this.cycleTimeoutMs);
  }

  _endCycle() {
    clearTimeout(this._cycleTimer);
    this._cycleTimer = null;
    this.socket.send(['CLOSE', SUB_ID]);
    this._polling = false;
    this._firstCycleDone = true;
    this._scheduleNext();
  }

  _scheduleNext() {
    if (this._stopped) return;
    clearTimeout(this._nextTimer);
    this._nextTimer = setTimeout(() => this._runCycle(), this.pollIntervalMs);
  }

  _handleFrame(msg) {
    const type = msg[0];
    const sub = msg[1];
    if (sub !== SUB_ID) return;

    if (type === 'EVENT') {
      const event = msg[2];
      if (!event || typeof event !== 'object' || !event.id) return;

      // advance cursor even for already-seen events (keeps `since` at the frontier)
      if (typeof event.created_at === 'number' && event.created_at > this._sinceCursor) {
        this._sinceCursor = event.created_at;
      }

      // suppress re-delivery of boundary events across cycles
      if (!this._remember(event.id)) return;

      const live = this._firstCycleDone;
      try {
        this.onEvent(event, { live });
      } catch (err) {
        this._log('subscribe: onEvent threw: ' + err.message);
      }
      return;
    }

    if (type === 'EOSE') {
      this._endCycle();
      return;
    }

    if (type === 'CLOSED') {
      const reason = msg[2] || '';
      if (reason && !/^duplicate|closed by client/i.test(reason)) {
        this._log('subscribe: CLOSED by relay: ' + reason);
      }
      if (this._polling) this._endCycle();
      return;
    }
  }

  _clearTimers() {
    clearTimeout(this._cycleTimer);
    clearTimeout(this._nextTimer);
    this._cycleTimer = null;
    this._nextTimer = null;
  }
}

export default Subscription;
