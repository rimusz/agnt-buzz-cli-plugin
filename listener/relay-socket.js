/**
 * relay-socket.js -- persistent, auto-reconnecting, NIP-42-authenticated
 * WebSocket link to a Buzz (Nostr) relay.
 *
 * Responsibilities:
 *   1. Open a wss:// link to the relay.
 *   2. Complete the NIP-42 AUTH handshake (relay sends ["AUTH", challenge] on
 *      connect; we reply with a signed kind-22242 event; relay answers ["OK",..,true]).
 *   3. Stay authenticated. On drop, reconnect with exponential backoff + jitter
 *      and re-AUTH automatically.
 *   4. Expose a tiny API for subscribe.js to send REQ/CLOSE and receive frames.
 *
 * Events emitted (EventEmitter):
 *   'open'         ()                       socket upgraded (pre-auth)
 *   'authed'       ()                       NIP-42 AUTH accepted
 *   'authfail'     (reason)                 AUTH rejected
 *   'frame'        (msg:Array)              every relay frame
 *   'notice'       (text)                   ["NOTICE", text]
 *   'dropped'      ({code, reason})         socket ended (reconnect scheduled)
 *   'reconnecting' ({attempt, delayMs})     backoff tick
 *   'error'        (err)
 *   'giveup'       ()
 *
 * Public methods: start(), stopLink(), send(arrayFrame), isAuthed(), get pubkey()
 */

import { EventEmitter } from 'events';
import { decodeNsec, getPublicKey, buildAuthEvent, toWebsocketUrl } from './nostr.js';

const DEFAULTS = {
  minBackoffMs: 1000,
  maxBackoffMs: 30000,
  backoffFactor: 2,
  jitterRatio: 0.25,
  maxReconnectAttempts: Infinity,
  authTimeoutMs: 15000,
  pingIntervalMs: 30000,
  connectTimeoutMs: 15000,
};

export class RelaySocket extends EventEmitter {
  constructor(opts) {
    super();
    if (!opts || !opts.relayUrl) throw new Error('relay-socket: relayUrl required');
    if (!opts.nsec) throw new Error('relay-socket: nsec required');
    this.wsUrl = toWebsocketUrl(opts.relayUrl);
    this.relayUrlForAuth = this.wsUrl;
    this._sk = decodeNsec(opts.nsec);
    this._pubkey = getPublicKey(this._sk);
    this._log = opts.log || (() => {});
    this.cfg = { ...DEFAULTS, ...(opts.tuning || {}) };
    this._ws = null;
    this._authed = false;
    this._stopped = false;
    this._attempt = 0;
    this._reconnectTimer = null;
    this._authTimer = null;
    this._pingTimer = null;
    this._connectTimer = null;
    this._pendingAuthId = null;
  }

  get pubkey() { return this._pubkey; }
  isAuthed() { return this._authed; }

  start() {
    if (this._stopped) this._stopped = false;
    this._connect();
    return this;
  }

  /** Graceful teardown -- ends the socket and cancels all reconnects. */
  stopLink() {
    this._stopped = true;
    this._clearTimers();
    if (this._ws) { try { this._ws.close(1000); } catch (e) {} }
    this._ws = null;
    this._authed = false;
    this._log('relay-socket: link stopped');
  }

  send(arrayFrame) {
    if (!this._ws || this._ws.readyState !== 1) return false;
    try { this._ws.send(JSON.stringify(arrayFrame)); return true; }
    catch (err) { this.emit('error', err); return false; }
  }

  _connect() {
    if (this._stopped) return;
    this._clearTimers();
    this._authed = false;
    let ws;
    try { ws = new WebSocket(this.wsUrl); }
    catch (err) { this.emit('error', err); return this._scheduleReconnect(); }
    this._ws = ws;
    this._connectTimer = setTimeout(() => {
      if (this._ws === ws && ws.readyState !== 1) {
        this._log('relay-socket: connect timeout');
        try { ws.close(); } catch (e) {}
      }
    }, this.cfg.connectTimeoutMs);
    ws.onopen = () => {
      clearTimeout(this._connectTimer);
      this._attempt = 0;
      this._log('relay-socket: OPEN ' + this.wsUrl);
      this.emit('open');
      this._authTimer = setTimeout(() => {
        if (!this._authed) {
          this._log('relay-socket: AUTH not completed in time - reconnecting');
          this._safeReopen();
        }
      }, this.cfg.authTimeoutMs);
    };
    ws.onmessage = (ev) => {
      let msg;
      const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString();
      try { msg = JSON.parse(raw); }
      catch (err) { this.emit('error', new Error('relay-socket: bad JSON frame: ' + raw.slice(0, 120))); return; }
      if (!Array.isArray(msg)) return;
      this._handleFrame(msg);
    };
    ws.onerror = (ev) => {
      this.emit('error', (ev && ev.error) || new Error('relay-socket: ws error ' + ((ev && ev.message) || '')));
    };
    ws.onclose = (ev) => {
      this._clearTimers();
      const wasAuthed = this._authed;
      this._authed = false;
      if (this._ws === ws) this._ws = null;
      this.emit('dropped', { code: ev && ev.code, reason: ev && ev.reason, wasAuthed });
      this._log('relay-socket: DROPPED code=' + (ev && ev.code) + ' reason=' + ((ev && ev.reason) || ''));
      this._scheduleReconnect();
    };
  }

  _handleFrame(msg) {
    const type = msg[0];
    if (type === 'AUTH' && typeof msg[1] === 'string') {
      const challenge = msg[1];
      const authEvt = buildAuthEvent({ relayUrl: this.relayUrlForAuth, challenge, sk: this._sk, pubkeyHex: this._pubkey });
      this._pendingAuthId = authEvt.id;
      const ok = this.send(['AUTH', authEvt]);
      this._log('relay-socket: sent AUTH id=' + authEvt.id.slice(0, 12) + ' (' + (ok ? 'queued' : 'send-failed') + ')');
      return;
    }
    if (type === 'OK' && msg[1] && msg[1] === this._pendingAuthId) {
      const accepted = msg[2] === true;
      if (accepted) {
        this._authed = true;
        clearTimeout(this._authTimer);
        this._log('relay-socket: AUTH accepted');
        this.emit('authed');
        this._startPing();
      } else {
        const reason = msg[3] || 'rejected';
        this._log('relay-socket: AUTH rejected: ' + reason);
        this.emit('authfail', reason);
        this._safeReopen();
      }
      this._pendingAuthId = null;
      return;
    }
    if (type === 'NOTICE') {
      this.emit('notice', msg[1]);
      this._log('relay-socket: NOTICE ' + String(msg[1]).slice(0, 160));
    }
    this.emit('frame', msg);
  }

  _startPing() {
    if (!this.cfg.pingIntervalMs) return;
    clearInterval(this._pingTimer);
    this._pingTimer = setInterval(() => {
      if (this._ws && this._ws.readyState === 1) this.emit('ping');
    }, this.cfg.pingIntervalMs);
  }

  _safeReopen() {
    if (this._ws) { try { this._ws.close(); } catch (e) {} }
    else { this._scheduleReconnect(); }
  }

  _scheduleReconnect() {
    if (this._stopped) return;
    if (this._reconnectTimer) return;
    this._attempt += 1;
    if (this._attempt > this.cfg.maxReconnectAttempts) {
      this._log('relay-socket: max reconnect attempts reached - giving up');
      this.emit('giveup');
      return;
    }
    const base = Math.min(this.cfg.maxBackoffMs, this.cfg.minBackoffMs * Math.pow(this.cfg.backoffFactor, this._attempt - 1));
    const jitter = base * this.cfg.jitterRatio * (Math.random() * 2 - 1);
    const delay = Math.max(0, Math.round(base + jitter));
    this.emit('reconnecting', { attempt: this._attempt, delayMs: delay });
    this._log('relay-socket: reconnect #' + this._attempt + ' in ' + delay + 'ms');
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._connect(); }, delay);
  }

  _clearTimers() {
    clearTimeout(this._reconnectTimer);
    clearTimeout(this._authTimer);
    clearTimeout(this._connectTimer);
    clearInterval(this._pingTimer);
    this._reconnectTimer = null;
    this._authTimer = null;
    this._connectTimer = null;
    this._pingTimer = null;
  }
}

export default RelaySocket;
