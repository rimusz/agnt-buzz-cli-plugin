# launchd reference

`com.agnt.annie-buzz-listener.plist.example` is a **reference copy** of the
macOS launchd job that supervises the listener.

You do not normally install it by hand — [`../install-listener.sh`](../install-listener.sh)
generates the real file at `~/Library/LaunchAgents/`, substituting the node
binary and install directory it detects. This copy exists so the *reasoning*
behind the job survives independently of a generated file:

- **why `KeepAlive` must be unconditional `<true/>`** — the pre-v1.4.4 dict form
  (`SuccessfulExit=false`) told launchd to ignore a clean `exit(0)`, which is
  exactly the case that caused the 3.5-hour outage on 2026-08-04;
- **why `ThrottleInterval` is 10** — relaunch-loop protection;
- **when the optional `EnvironmentVariables` block is needed** — only to point
  the listener at config/state/log files somewhere other than its own directory,
  or to give a launchd job a `PATH` that includes the `buzz` CLI.

Placeholders `__NODE__` and `__DIR__` must be replaced before use. Lint before
loading:

```sh
plutil -lint com.agnt.annie-buzz-listener.plist
launchctl bootstrap gui/$(id -u) com.agnt.annie-buzz-listener.plist
```

To stop the listener deliberately, unload the job rather than killing the
process — with `KeepAlive` true, launchd will just start it again:

```sh
launchctl bootout gui/$(id -u)/com.agnt.annie-buzz-listener
```
