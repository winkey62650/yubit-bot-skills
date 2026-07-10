#!/bin/zsh
set -e

SOURCE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SERVICE_DIR="${YUBIT_SERVICE_DIR:-$HOME/Library/Application Support/YubitBot/yubit-bot-skills}"
PLIST="$HOME/Library/LaunchAgents/com.yubit.bot-skills.plist"

mkdir -p "$(dirname "$SERVICE_DIR")"
rsync -a --delete \
  --exclude 'node_modules' \
  --exclude '.git' \
  --exclude '.next' \
  --exclude 'generated' \
  --exclude 'tmp' \
  "$SOURCE_DIR/" "$SERVICE_DIR/"

launchctl kickstart -kp "gui/$(id -u)/com.yubit.bot-skills" 2>/dev/null || {
  if [[ ! -f "$PLIST" ]]; then
    echo "LaunchAgent is not installed. Run: zsh scripts/install-launchd-service.zsh" >&2
    exit 1
  fi
  launchctl bootout "gui/$(id -u)" "$PLIST" >/dev/null 2>&1 || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"
}

for attempt in {1..20}; do
  if curl -fsS "http://localhost:${PORT:-4173}/api/social-status" >/dev/null 2>&1; then
    break
  fi
  sleep 1
  if [[ "$attempt" -eq 20 ]]; then
    echo "Service restarted, but health check did not respond on port ${PORT:-4173}." >&2
    exit 1
  fi
done

echo "Synced and restarted com.yubit.bot-skills"
