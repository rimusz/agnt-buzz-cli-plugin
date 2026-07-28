#!/bin/sh
# install-listener.sh — set up the Buzz real-time reply listener (opt-in companion).
#
# Makes your AGNT agent auto-reply to Buzz DMs/mentions in ~3s. This is OPTIONAL —
# the buzz-* tools work without it. The listener is an always-on background
# process; on macOS it installs a LaunchAgent, elsewhere it prints a systemd unit.
#
# Requirements:
#   - node (18+), the `buzz` CLI, a running AGNT backend (localhost:3333)
#   - your agent's Buzz identity provisioned (buzz-provision-identity) + relay member
#
# Usage:
#   ./install-listener.sh                 # interactive-ish; uses config.json if present
#   ./install-listener.sh --observe       # install in observe-only mode (sends nothing)
#   ./install-listener.sh --uninstall     # stop + remove the service
#
# Config: edit config.json (copy from config.template.json) BEFORE running, or
# export BUZZ_RELAY_URL / BUZZ_PRIVATE_KEY (or nsec path) / AGNT_AUTH_TOKEN.

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.agnt.buzz-listener"
NODE="$(command -v node || echo /usr/bin/node)"
OBSERVE=""
[ "$1" = "--observe" ] && OBSERVE="--observe"

# ---- uninstall ----
if [ "$1" = "--uninstall" ]; then
  if [ "$(uname)" = "Darwin" ]; then
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
    rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
    echo "Uninstalled LaunchAgent $LABEL."
  else
    systemctl --user stop buzz-listener 2>/dev/null || true
    systemctl --user disable buzz-listener 2>/dev/null || true
    echo "Stopped systemd user service buzz-listener (remove the unit file manually if desired)."
  fi
  exit 0
fi

# ---- config ----
CFG="$DIR/config.json"
if [ ! -f "$CFG" ]; then
  if [ -n "$BUZZ_RELAY_URL" ]; then
    echo "No config.json — generating one from environment variables..."
    cat > "$CFG" <<EOF
{
  "relayUrl": "${BUZZ_RELAY_URL}",
  "buzzBin": "$(command -v buzz || echo buzz)",
  "nsecPath": "${BUZZ_NSEC_PATH:-~/.buzz/agent.nsec}",
  "agntApi": "${AGNT_API:-http://localhost:3333/api}",
  "agntTokenPath": "${AGNT_TOKEN_PATH:-~/.buzz/agnt.token}",
  "llmProvider": "${LLM_PROVIDER:-GrokAI}",
  "llmModel": "${LLM_MODEL:-grok-4.5}",
  "pollIntervalMs": 3000
}
EOF
    echo "Wrote $CFG — review it, then re-run this script."
    exit 0
  fi
  echo "ERROR: $CFG not found."
  echo "  Copy config.template.json -> config.json and fill it in, then re-run."
  echo "  (Or export BUZZ_RELAY_URL + related vars and re-run to auto-generate.)"
  exit 1
fi

echo "Using node: $NODE"
echo "Config:     $CFG"

# ---- quick preflight ----
"$NODE" --check "$DIR/index.js" || { echo "syntax error in index.js"; exit 1; }
echo "Preflight: index.js OK"

# ---- macOS: LaunchAgent ----
if [ "$(uname)" = "Darwin" ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  # ProgramArguments: node index.js [--observe]
  OBS_LINE=""
  [ -n "$OBSERVE" ] && OBS_LINE="    <string>--observe</string>"
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$DIR/index.js</string>
$OBS_LINE
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/><key>Crashed</key><true/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$DIR/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$DIR/launchd.err.log</string>
</dict>
</plist>
EOF
  plutil -lint "$PLIST" >/dev/null
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
  sleep 3
  echo ""
  echo "Installed + started LaunchAgent $LABEL ${OBSERVE:+(observe-only)}."
  echo "  status: launchctl list | grep buzz-listener"
  echo "  logs:   tail -f $DIR/listener.log"
  echo "  stop:   $0 --uninstall"
  echo ""
  echo "Recent log:"
  sleep 2
  tail -6 "$DIR/listener.log" 2>/dev/null || echo "  (starting…)"
  exit 0
fi

# ---- Linux: print a systemd user unit ----
cat <<EOF

Not macOS — here is a systemd --user unit. Save it, then enable it:

  mkdir -p ~/.config/systemd/user
  cat > ~/.config/systemd/user/buzz-listener.service <<'UNIT'
[Unit]
Description=Buzz real-time reply listener (AGNT)
After=network-online.target

[Service]
ExecStart=$NODE $DIR/index.js $OBSERVE
WorkingDirectory=$DIR
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT

  systemctl --user daemon-reload
  systemctl --user enable --now buzz-listener
  journalctl --user -u buzz-listener -f
EOF
