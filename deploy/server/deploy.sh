#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/winkey62650/yubit-bot-skills.git}"
BRANCH="${BRANCH:-code/academy}"
SOURCE_DIR="${SOURCE_DIR:-}"
APP_ROOT="${APP_ROOT:-/opt/yubit-academy}"
STATE_ROOT="${STATE_ROOT:-/var/lib/yubit-academy/runtime}"
NODE_HOME="${NODE_HOME:-/opt/yubit-node}"
SERVER_NAME="${SERVER_NAME:-152-32-161-174.sslip.io}"
SERVER_IP="${SERVER_IP:-152.32.161.174}"
ENV_FILE="${ENV_FILE:-/etc/yubit-academy/production.env}"
ENABLE_HTTPS="${ENABLE_HTTPS:-1}"
PATH="$NODE_HOME/bin:$PATH"

wait_for_service_active() {
  local service="$1"
  local attempts="${2:-30}"
  local attempt

  for ((attempt = 1; attempt <= attempts; attempt += 1)); do
    if sudo systemctl is-active --quiet "$service"; then
      echo "$service: active"
      return 0
    fi
    sleep 2
  done

  echo "$service did not become active after $((attempts * 2)) seconds." >&2
  sudo systemctl status "$service" --no-pager --full >&2 || true
  sudo journalctl -u "$service" -n 100 --no-pager >&2 || true
  return 1
}

if [[ ! -s "$ENV_FILE" ]]; then
  echo "Missing production environment file: $ENV_FILE" >&2
  exit 1
fi
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  echo "Node runtime not found at $NODE_HOME/bin/node" >&2
  exit 1
fi

sudo install -d -m 0755 -o ubuntu -g ubuntu "$APP_ROOT/releases"
sudo install -d -m 0750 -o ubuntu -g ubuntu "$STATE_ROOT"
discord_credentials_key="$(sudo awk -F= '$1 == "DISCORD_CREDENTIALS_ENCRYPTION_KEY" { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
if [[ -z "$discord_credentials_key" ]]; then
  discord_credentials_key="$(openssl rand -hex 32)"
fi

if [[ -n "$SOURCE_DIR" ]]; then
  if [[ ! "${EXPECTED_COMMIT:-}" =~ ^[0-9a-f]{40}$ ]]; then
    echo "Uploaded releases require a valid EXPECTED_COMMIT." >&2
    exit 1
  fi
  if [[ ! -d "$SOURCE_DIR" || ! -f "$SOURCE_DIR/package.json" ]]; then
    echo "Uploaded release source is missing or invalid: $SOURCE_DIR" >&2
    exit 1
  fi
  commit="$EXPECTED_COMMIT"
else
  commit="$({ git ls-remote "$REPO_URL" "refs/heads/$BRANCH" || true; } | awk 'NR==1 {print $1}')"
  if [[ -z "$commit" ]]; then
    echo "Unable to resolve $REPO_URL branch $BRANCH" >&2
    exit 1
  fi
  if [[ -n "${EXPECTED_COMMIT:-}" && "$commit" != "$EXPECTED_COMMIT" ]]; then
    echo "Resolved commit $commit does not match requested commit $EXPECTED_COMMIT" >&2
    exit 1
  fi
fi
release="$APP_ROOT/releases/$commit"
release_marker="$release/.release-commit"
installed_commit=""
if [[ -f "$release_marker" ]]; then
  installed_commit="$(cat "$release_marker")"
fi

if [[ "$installed_commit" != "$commit" ]]; then
  tmp_release="${release}.building"
  rm -rf "$tmp_release"
  mkdir -p "$tmp_release"
  if [[ -n "$SOURCE_DIR" ]]; then
    cp -a "$SOURCE_DIR/." "$tmp_release/"
  else
    rm -rf "$tmp_release"
    git clone --quiet --depth 1 --branch "$BRANCH" "$REPO_URL" "$tmp_release"
  fi
  printf '%s\n' "$commit" >"$tmp_release/.release-commit"
  rm -rf "$release"
  mv "$tmp_release" "$release"
fi

cd "$release"
cta_preview_evidence_secret_count="$(sudo awk -F= '$1 == "CTA_PREVIEW_EVIDENCE_SECRET" { count += 1 } END { print count + 0 }' "$ENV_FILE")"
if [[ "$cta_preview_evidence_secret_count" != "1" ]]; then
  echo "CTA_PREVIEW_EVIDENCE_SECRET must be configured exactly once." >&2
  exit 1
fi
cta_preview_evidence_secret="$(sudo awk -F= '$1 == "CTA_PREVIEW_EVIDENCE_SECRET" { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
if [[ -z "$cta_preview_evidence_secret" ]]; then
  echo "CTA_PREVIEW_EVIDENCE_SECRET is not configured." >&2
  exit 1
fi
CTA_PREVIEW_EVIDENCE_SECRET="$cta_preview_evidence_secret" "$NODE_HOME/bin/node" <<'NODE'
try {
  const { assertStrongCtaPreviewEvidenceSecret } = require("./lib/cta-preview-evidence.cjs");
  assertStrongCtaPreviewEvidenceSecret(process.env.CTA_PREVIEW_EVIDENCE_SECRET);
} catch {
  console.error("CTA_PREVIEW_EVIDENCE_SECRET is missing or invalid.");
  process.exit(1);
}
NODE
unset cta_preview_evidence_secret
unset cta_preview_evidence_secret_count

primary_env="$(mktemp)"
env_pending="${ENV_FILE}.pending-$$"
cleanup_env_update() {
  rm -f "$primary_env"
  sudo rm -f "$env_pending"
}
trap cleanup_env_update EXIT
sudo awk '!/^(JSON_STORE_BACKEND|JSON_STORE_DIRECTORY|DISCORD_APP_ID|DISCORD_PUBLIC_KEY|DISCORD_BOT_TOKEN|DISCORD_GATEWAY_ENABLED|DISCORD_CREDENTIALS_ENCRYPTION_KEY)=/' "$ENV_FILE" >"$primary_env"
{
  printf 'JSON_STORE_BACKEND=local\n'
  printf 'JSON_STORE_DIRECTORY=%s\n' "$STATE_ROOT"
  printf 'DISCORD_CREDENTIALS_ENCRYPTION_KEY=%s\n' "$discord_credentials_key"
} >>"$primary_env"
sudo install -m 0600 -o root -g root "$primary_env" "$env_pending"
sudo mv -f "$env_pending" "$ENV_FILE"
rm -f "$primary_env"
env_pending=""
trap - EXIT
unset discord_credentials_key
npm ci --no-audit --no-fund
sudo ENV_FILE="$ENV_FILE" "$NODE_HOME/bin/node" scripts/check-production-database.mjs
npm run check
npm test
npm run build

# Next.js standalone output omits public/ and static assets. Copy them into the
# runtime bundle so systemd can run server.js directly.
rm -rf "$release/.next/standalone/public" "$release/.next/standalone/.next/static"
if [[ -d "$release/public" ]]; then
  cp -a "$release/public" "$release/.next/standalone/public"
fi
mkdir -p "$release/.next/standalone/.next"
cp -a "$release/.next/static" "$release/.next/standalone/.next/static"

if [[ -d "$APP_ROOT/current/.runtime" && ! -L "$APP_ROOT/current/.runtime" ]]; then
  sudo cp -an "$APP_ROOT/current/.runtime/." "$STATE_ROOT/"
fi
if [[ -L "$release/.runtime" ]]; then
  if [[ "$(readlink "$release/.runtime")" != "$STATE_ROOT" ]]; then
    echo "Release runtime points to an unexpected directory: $release/.runtime" >&2
    exit 1
  fi
elif [[ -e "$release/.runtime" ]]; then
  echo "Release runtime path must be a persistent-state symlink: $release/.runtime" >&2
  exit 1
else
  ln -s "$STATE_ROOT" "$release/.runtime"
fi

sudo install -m 0644 deploy/systemd/yubit-academy-web.service /etc/systemd/system/yubit-academy-web.service
sudo install -m 0644 deploy/systemd/yubit-academy-worker.service /etc/systemd/system/yubit-academy-worker.service
sudo install -m 0644 deploy/systemd/yubit-academy-discord.service /etc/systemd/system/yubit-academy-discord.service
release_env="$(mktemp)"
{
  printf 'APP_RELEASE_SHA=%s\n' "$commit"
  printf 'APP_RELEASE_REF=%s\n' "$BRANCH"
  printf 'APP_ENVIRONMENT=production\n'
  printf 'APP_DEPLOYMENT_URL=https://%s\n' "$SERVER_NAME"
  printf 'JSON_STORE_BACKEND=local\n'
  printf 'JSON_STORE_DIRECTORY=%s\n' "$STATE_ROOT"
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
sudo systemctl stop yubit-academy-worker.service 2>/dev/null || true
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
sudo systemctl enable yubit-academy-discord.service
sudo systemctl restart yubit-academy-discord.service
wait_for_service_active yubit-academy-web.service
wait_for_service_active yubit-academy-worker.service
wait_for_service_active yubit-academy-discord.service
sudo systemctl reload nginx

if [[ "$ENABLE_HTTPS" == "1" ]]; then
  if ! command -v certbot >/dev/null 2>&1; then
    sudo apt-get update -qq
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y certbot python3-certbot-nginx
  fi
  sudo certbot --nginx --non-interactive --agree-tos --register-unsafely-without-email --redirect -d "$SERVER_NAME"
fi

curl --fail --silent --show-error --max-time 10 "https://$SERVER_NAME/login" >/dev/null
public_location="$(curl --fail --silent --show-error --head --max-time 10 "https://$SERVER_NAME/" \
  | tr -d '\r' | awk 'tolower($1) == "location:" { print $2; exit }')"
if [[ "$public_location" != "https://$SERVER_NAME/login" ]]; then
  echo "Public root redirects to an invalid login URL: ${public_location:-missing}" >&2
  exit 1
fi
ip_location="$(curl --fail --silent --show-error --head --max-time 10 "http://$SERVER_IP/" \
  | tr -d '\r' | awk 'tolower($1) == "location:" { print $2; exit }')"
if [[ "$ip_location" != "https://$SERVER_NAME/" ]]; then
  echo "Server IP does not redirect to the public HTTPS URL: ${ip_location:-missing}" >&2
  exit 1
fi
wait_for_service_active yubit-academy-web.service 5
wait_for_service_active yubit-academy-worker.service 5
wait_for_service_active yubit-academy-discord.service 5
if sudo grep -Eq '^(DISCORD_APP_ID|DISCORD_PUBLIC_KEY|DISCORD_BOT_TOKEN|DISCORD_GATEWAY_ENABLED)=' "$ENV_FILE"; then
  echo "Legacy Discord environment credentials remain configured." >&2
  exit 1
fi
echo "Discord legacy environment credentials: absent"
echo "Discord gateway service: active"

find "$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -path "$release" -printf '%T@ %p\n' \
  | sort -nr | awk 'NR > 2 {sub(/^[^ ]+ /, ""); print}' \
  | xargs -r sudo rm -rf

echo "Deployed $commit to https://$SERVER_NAME"
