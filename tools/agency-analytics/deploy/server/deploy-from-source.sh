#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DIR="${SOURCE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
APP_ROOT="${APP_ROOT:-/opt/agency-analytics}"
DATA_ROOT="${DATA_ROOT:-/var/lib/agency-analytics}"
ENV_ROOT="${ENV_ROOT:-/etc/agency-analytics}"
SERVER_NAME="${SERVER_NAME:-analytics.152-32-161-174.sslip.io}"
NODE_HOME="${NODE_HOME:-/opt/yubit-node}"
ADMIN_USER="${ADMIN_USER:-admin}"
ENABLE_HTTPS="${ENABLE_HTTPS:-1}"
PATH="$NODE_HOME/bin:$PATH"

if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
  echo "ADMIN_PASSWORD is required" >&2
  exit 1
fi
if [[ ! -f "$SOURCE_DIR/package-lock.json" ]]; then
  echo "Source directory is not an installed agency-analytics checkout: $SOURCE_DIR" >&2
  exit 1
fi
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  echo "Node runtime not found at $NODE_HOME/bin/node" >&2
  exit 1
fi

release_id="$(date -u +%Y%m%d%H%M%S)-$(sha256sum "$SOURCE_DIR/package-lock.json" | cut -c1-10)"
release="$APP_ROOT/releases/$release_id"

sudo install -d -m 0755 -o ubuntu -g ubuntu "$APP_ROOT/releases" "$release"
sudo install -d -m 0750 -o ubuntu -g ubuntu "$DATA_ROOT"
sudo install -d -m 0750 -o root -g www-data "$ENV_ROOT"

rsync -a --delete \
  --exclude node_modules \
  --exclude .next \
  --exclude data \
  --exclude screenshots \
  "$SOURCE_DIR/" "$release/"

cd "$release"
npm ci --no-audit --no-fund
npm run build

env_tmp="$(mktemp)"
printf 'AGENCY_ANALYTICS_DATA_DIR=%s\nNEXT_PUBLIC_DASHBOARD_REFRESH_MS=30000\n' "$DATA_ROOT" >"$env_tmp"
sudo install -m 0640 -o root -g ubuntu "$env_tmp" "$ENV_ROOT/production.env"
rm -f "$env_tmp"

password_hash="$(printf '%s\n' "$ADMIN_PASSWORD" | openssl passwd -apr1 -stdin)"
htpasswd_tmp="$(mktemp)"
printf '%s:%s\n' "$ADMIN_USER" "$password_hash" >"$htpasswd_tmp"
sudo install -m 0640 -o root -g www-data "$htpasswd_tmp" "$ENV_ROOT/htpasswd"
rm -f "$htpasswd_tmp"

sudo ln -sfn "$release" "$APP_ROOT/current"
sudo chown -h ubuntu:ubuntu "$APP_ROOT/current"
sudo install -m 0644 deploy/systemd/agency-analytics.service /etc/systemd/system/agency-analytics.service

nginx_tmp="$(mktemp)"
sed "s/__SERVER_NAME__/$SERVER_NAME/g" deploy/nginx/agency-analytics.conf >"$nginx_tmp"
sudo install -m 0644 "$nginx_tmp" /etc/nginx/sites-available/agency-analytics.conf
rm -f "$nginx_tmp"
sudo ln -sfn /etc/nginx/sites-available/agency-analytics.conf /etc/nginx/sites-enabled/agency-analytics.conf
sudo nginx -t

sudo systemctl daemon-reload
sudo systemctl enable agency-analytics.service
sudo systemctl restart agency-analytics.service

for attempt in {1..30}; do
  if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:4180/api/health >/dev/null; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then
    sudo journalctl -u agency-analytics.service -n 100 --no-pager >&2
    exit 1
  fi
  sleep 2
done

sudo systemctl reload nginx
if [[ "$ENABLE_HTTPS" == "1" ]]; then
  if ! command -v certbot >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-nginx
  fi
  sudo certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d "$SERVER_NAME"
  public_health_url="https://$SERVER_NAME/api/health"
else
  public_health_url="http://$SERVER_NAME/api/health"
fi

curl --fail --silent --show-error --max-time 10 "$public_health_url" >/dev/null
sudo systemctl is-active --quiet agency-analytics.service

find "$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -path "$release" -printf '%T@ %p\n' \
  | sort -nr | awk 'NR > 2 {sub(/^[^ ]+ /, ""); print}' \
  | xargs -r rm -rf

echo "Deployed Site Nerve to $public_health_url"
