# buzz-cli-plugin v1.4.4

**Reliability release. If you run the listener companion on macOS, please upgrade —
and re-run the installer, not just the code.**

## The short version

A routine relay restart could take the listener permanently offline: no crash, no
error, no log line, no reply to anyone. Seen live — a ~30 second relay upgrade
produced a **3.5 hour** blackout that only ended when the process was restarted
by hand.

The base `buzz-*` tools are unaffected. This is the opt-in listener only.

## What actually happened

```
15:17:57Z  DROPPED code=1012 reason=relay restarting     <- relay upgraded
15:17:57Z  reconnect #1 in 1151ms                        <- correct so far
15:17:58Z  error: Received network error or non-101 status code
15:18:13Z  connect timeout
15:18:13Z  error: Connection was closed before it was established.
           <silence. no reconnect #2. process exits 0. nothing restarts it.>
```

Two bugs had to line up.

**1. The reconnect was lost on the connect-timeout path.**
`_scheduleReconnect()` was reachable only from `ws.onclose`. The connect-timeout
handler called `ws.close()` and assumed `onclose` would follow — but with
Node/undici `WebSocket`, closing a socket still in `CONNECTING` whose handshake
already failed emits an **error** and **never fires `onclose`**. That exact error
is the last line in the log above. With `maxReconnectAttempts: Infinity` the
`giveup` branch (the only one that exits non-zero) was also unreachable, so the
listener couldn't even report its own death.

**2. A clean exit was the one status the supervisor ignored.**
With the reconnect timer gone, nothing held the event loop open, so Node exited
**0**. The generated LaunchAgent said:

```xml
<key>KeepAlive</key>
<dict><key>SuccessfulExit</key><false/><key>Crashed</key><true/></dict>
```

launchd reads `SuccessfulExit=false` as *"relaunch only on a **non-zero** exit"*.
A clean `exit(0)` is precisely what it was told to skip. The process found the
one hole in its own supervision.

## The fix

- **`relay-socket.js`** — new `_settle(ws, info)`, the single terminal path for a
  socket. Idempotent per-socket (a `WeakSet`, so a late duplicate close for an
  older socket isn't mistaken for a fresh drop), always ends in
  `_scheduleReconnect()`, and is called from `onclose`, the connect-timeout
  handler **and** `onerror`-while-not-open. `_safeReopen()` gets a 1s fallback.
- **`index.js`** — a liveness watchdog on a 30s interval, deliberately **not**
  `unref`'d. Two guarantees: the event loop can never drain to a silent `exit 0`,
  and >`staleAfterMs` unauthenticated exits non-zero for the supervisor. Either
  one alone would have capped the outage at 5 minutes.
- **`install-listener.sh`** — `KeepAlive` is now unconditional `<true/>`.
  systemd was already correct (`Restart=always`).
- **New config keys** — `staleAfterMs` (300000), `watchdogTickMs` (30000).

## Verification

`listener/reconnect-regression.test.mjs`, 12/12 passing. Hermetic: no network, no
relay, no credentials, `nostr.js` stubbed so `@noble` isn't needed.

```
[1] PRE-FIX code (v1.4.3), outage scenario
  PASS  reproduces the bug: NO reconnect scheduled
  PASS  reproduces the bug: link left dead (1 socket only)
  PASS  reproduces the bug: no giveup either
[2] CURRENT code, same outage scenario                    3 PASS
[3] CURRENT code, well-behaved close (no regression)      2 PASS
[4] CURRENT code, idempotency: late duplicate close       1 PASS
[5] CURRENT code, stopLink() still cancels reconnects     1 PASS
[6] installer ships an unconditional KeepAlive            2 PASS
```

Case **[1]** pulls the shipped v1.4.3 file from git history and asserts it
**fails** — proof the suite reproduces the real bug, and confirmation that every
release from v1.3.1 through v1.4.3 carries it. Case **[4]** caught a genuine flaw
in the first draft of this fix (a single-slot marker that double-fired `dropped`);
the `WeakSet` is the correction.

Additionally verified on a live install: `kill <pid>` → SIGTERM → `process.exit(0)`
— the exact status ignored before — now restarts automatically in **0.6 s**
(`runs 1 → 2`, `last exit code = 0`, followed by `AUTH accepted`).

## Upgrading

**macOS listener users (v1.3.1–v1.4.3): re-run the installer.** The LaunchAgent
plist has to be regenerated — copying the JS alone leaves bug #2 in place.

```bash
cd listener && ./install-listener.sh
```

Linux/systemd users: code only, no unit change needed.
