#!/bin/zsh
set -e

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="${YUBIT_SERVICE_DIR:-$HOME/Library/Application Support/YubitBot/yubit-bot-skills}"
LAUNCHER="$HOME/.local/bin/yubit-server-launchd.zsh"
PLIST="$HOME/Library/LaunchAgents/com.yubit.bot-skills.plist"
NODE_BIN="${NODE_BIN:-/Users/winkey/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node}"
PORT="${PORT:-4173}"

if [[ ! -x "$NODE_BIN" ]]; then
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "Node.js not found. Set NODE_BIN=/path/to/node and rerun." >&2
  exit 1
fi

mkdir -p "$HOME/.local/bin" "$HOME/Library/LaunchAgents" "$(dirname "$SERVICE_DIR")"

cat > "$LAUNCHER" <<EOF
#!/bin/zsh
set -e

{
  echo "[\$(date '+%Y-%m-%dT%H:%M:%S%z')] yubit-server-launchd starting"
  echo "user=\$(id -un) uid=\$(id -u)"
} >> /tmp/yubit-server-launchd.debug.log 2>&1

export PATH="$(dirname "$NODE_BIN"):/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PORT="\${PORT:-$PORT}"
export YUBIT_ROOT="$SERVICE_DIR"

cd "$HOME"
echo "[\$(date '+%Y-%m-%dT%H:%M:%S%z')] launching server with YUBIT_ROOT=\$YUBIT_ROOT from \$(pwd)" >> /tmp/yubit-server-launchd.debug.log 2>&1
exec "$NODE_BIN" "$SERVICE_DIR/server.mjs" >> /tmp/yubit-server-launchd.node.log 2>&1
EOF
chmod 755 "$LAUNCHER"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.yubit.bot-skills</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/zsh</string>
    <string>-f</string>
    <string>$LAUNCHER</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PORT</key>
    <string>$PORT</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>/tmp/yubit-bot-skills.launchd.out.log</string>
  <key>StandardErrorPath</key>
  <string>/tmp/yubit-bot-skills.launchd.err.log</string>
</dict>
</plist>
EOF

plutil -lint "$PLIST"
"$SOURCE_DIR/scripts/sync-launchd-service.zsh"

echo "Installed com.yubit.bot-skills"
echo "Open http://localhost:$PORT/admin-group-config.html"
