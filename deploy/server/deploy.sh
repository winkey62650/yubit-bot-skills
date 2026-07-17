#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/winkey62650/yubit-bot-skills.git}"
BRANCH="${BRANCH:-code/academy}"
APP_ROOT="${APP_ROOT:-/opt/yubit-academy}"
NODE_HOME="${NODE_HOME:-/opt/yubit-node}"
SERVER_NAME="${SERVER_NAME:-152-32-161-174.sslip.io}"
SERVER_IP="${SERVER_IP:-152.32.161.174}"
ENV_FILE="${ENV_FILE:-/etc/yubit-academy/production.env}"
ENABLE_HTTPS="${ENABLE_HTTPS:-1}"
PATH="$NODE_HOME/bin:$PATH"

if [[ ! -s "$ENV_FILE" ]]; then
  echo "Missing production environment file: $ENV_FILE" >&2
  exit 1
fi
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  echo "Node runtime not found at $NODE_HOME/bin/node" >&2
  exit 1
fi

sudo install -d -m 0755 -o ubuntu -g ubuntu "$APP_ROOT/releases"
commit="$({ git ls-remote "$REPO_URL" "refs/heads/$BRANCH" || true; } | awk 'NR==1 {print $1}')"
if [[ -z "$commit" ]]; then
  echo "Unable to resolve $REPO_URL branch $BRANCH" >&2
  exit 1
fi
release="$APP_ROOT/releases/$commit"

if [[ ! -d "$release/.git" ]]; then
  tmp_release="${release}.building"
  rm -rf "$tmp_release"
  git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$tmp_release"
  mv "$tmp_release" "$release"
fi

cd "$release"
npm ci --no-audit --no-fund
npm run check
npm test
npm run build

sudo install -m 0644 deploy/systemd/yubit-academy-web.service /etc/systemd/system/yubit-academy-web.service
sudo install -m 0644 deploy/systemd/yubit-academy-worker.service /etc/systemd/system/yubit-academy-worker.service
release_env="$(mktemp)"
{
  printf 'APP_RELEASE_SHA=%s\n' "$commit"
  printf 'APP_RELEASE_REF=%s\n' "$BRANCH"
  printf 'APP_ENVIRONMENT=production\n'
  printf 'APP_DEPLOYMENT_URL=https://%s\n' "$SERVER_NAME"
} >"$release_env"
sudo install -m 0644 "$release_env" /etc/yubit-academy/release.env
rm -f "$release_env"
sudo ln -sfn "$release" "$APP_ROOT/current"
sudo chown -h ubuntu:ubuntu "$APP_ROOT/current"

nginx_tmp="$(mktemp)"
sed -e "s/__SERVER_NAME__/$SERVER_NAME/g" -e "s/__SERVER_IP__/$SERVER_IP/g" deploy/nginx/yubit-academy.conf >"$nginx_tmp"
sudo install -m 0644 "$nginx_tmp" /etc/nginx/sites-available/yubit-academy.conf
rm -f "$nginx_tmp"
sudo ln -sfn /etc/nginx/sites-available/yubit-academy.conf /etc/nginx/sites-enabled/yubit-academy.conf
sudo rm -f /etc/nginx/sites-enabled/yubit-tg.conf
sudo nginx -t

sudo systemctl daemon-reload
sudo systemctl disable --now yubit-bot-skills.service yubit-news-console.service 2>/dev/null || true
sudo systemctl enable yubit-academy-web.service
sudo systemctl restart yubit-academy-web.service

for attempt in {1..30}; do
  if curl --fail --silent --show-error --max-time 5 http://127.0.0.1:4174/login >/dev/null; then
    break
  fi
  if [[ "$attempt" == 30 ]]; then
    sudo journalctl -u yubit-academy-web.service -n 100 --no-pager >&2
    exit 1
  fi
  sleep 2
done

sudo systemctl enable yubit-academy-worker.service
sudo systemctl restart yubit-academy-worker.service
sudo systemctl reload nginx

if [[ "$ENABLE_HTTPS" == "1" ]]; then
  if ! command -v certbot >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-nginx
  fi
  sudo certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d "$SERVER_NAME"
fi

curl --fail --silent --show-error --max-time 10 "https://$SERVER_NAME/login" >/dev/null
sudo systemctl is-active --quiet yubit-academy-web.service
sudo systemctl is-active --quiet yubit-academy-worker.service

find "$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -path "$release" -printf '%T@ %p\n' \
  | sort -nr | awk 'NR > 2 {sub(/^[^ ]+ /, ""); print}' \
  | xargs -r rm -rf

echo "Deployed $commit to https://$SERVER_NAME"
