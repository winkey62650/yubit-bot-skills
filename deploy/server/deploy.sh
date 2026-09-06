#!/usr/bin/env bash
set -Eeuo pipefail

REPO_URL="${REPO_URL:-https://github.com/winkey62650/yubit-bot-skills.git}"
BRANCH="${BRANCH:-code/academy}"
SOURCE_DIR="${SOURCE_DIR:-}"
APP_ROOT="${APP_ROOT:-/opt/yubit-academy}"
STATE_ROOT="${STATE_ROOT:-/var/lib/yubit-academy/runtime}"
OBSIDIAN_VAULT_PATH="${OBSIDIAN_VAULT_PATH:-/var/lib/yubit-academy/obsidian-vault}"
OBSIDIAN_BACKUP_ROOT="${OBSIDIAN_BACKUP_ROOT:-/var/backups/yubit-academy/obsidian-vault}"
NODE_HOME="${NODE_HOME:-/opt/yubit-node}"
SERVER_NAME="${SERVER_NAME:-152-32-161-174.sslip.io}"
SERVER_IP="${SERVER_IP:-152.32.161.174}"
ENV_FILE="${ENV_FILE:-/etc/yubit-academy/production.env}"
ENABLE_HTTPS="${ENABLE_HTTPS:-1}"
DEPLOY_NO_SEND="${DEPLOY_NO_SEND:-1}"
PATH="$NODE_HOME/bin:$PATH"
LOCAL_DATABASE_NAME="${LOCAL_DATABASE_NAME:-yubit_academy}"
LOCAL_DATABASE_USER="${LOCAL_DATABASE_USER:-yubit_academy}"
if [[ ! "$LOCAL_DATABASE_NAME" =~ ^[a-z_][a-z0-9_]*$ || ! "$LOCAL_DATABASE_USER" =~ ^[a-z_][a-z0-9_]*$ ]]; then
  echo "Local PostgreSQL database and user names are invalid." >&2
  exit 1
fi
if [[ "$DEPLOY_NO_SEND" != "1" ]]; then
  echo "This deployment entry point only permits DEPLOY_NO_SEND=1; activation requires a separately approved procedure." >&2
  exit 1
fi

provision_obsidian_vault() {
  local content_state_root="/var/lib/yubit-academy"
  local normalized_vault_path
  local relative_path
  local current_path
  local component
  local content_state_root_real
  local vault_path_real
  local -a vault_components

  if [[ "$OBSIDIAN_VAULT_PATH" != /* ]]; then
    echo "Obsidian vault path must be absolute: $OBSIDIAN_VAULT_PATH" >&2
    return 1
  fi
  normalized_vault_path="$(realpath -m -- "$OBSIDIAN_VAULT_PATH")"
  if [[ "$normalized_vault_path" != "$content_state_root/"* ]]; then
    echo "Vault path must remain under /var/lib/yubit-academy: $normalized_vault_path" >&2
    return 1
  fi
  OBSIDIAN_VAULT_PATH="$normalized_vault_path"

  if sudo test -L "$content_state_root"; then
    echo "Refusing symlinked Obsidian vault path component: $content_state_root" >&2
    return 1
  fi
  sudo install -d -m 0755 -o ubuntu -g ubuntu "$content_state_root"
  content_state_root_real="$(sudo realpath -e -- "$content_state_root")"
  relative_path="${OBSIDIAN_VAULT_PATH#"$content_state_root"/}"
  current_path="$content_state_root"
  IFS='/' read -r -a vault_components <<<"$relative_path"
  for component in "${vault_components[@]}"; do
    [[ -n "$component" ]] || continue
    current_path="$current_path/$component"
    if sudo test -L "$current_path"; then
      echo "Refusing symlinked Obsidian vault path component: $current_path" >&2
      return 1
    fi
    if sudo test -e "$current_path" && ! sudo test -d "$current_path"; then
      echo "Obsidian vault path component is not a directory: $current_path" >&2
      return 1
    fi
    if ! sudo test -d "$current_path"; then
      sudo install -d -m 0750 -o ubuntu -g ubuntu "$current_path"
    fi
  done

  vault_path_real="$(sudo realpath -e -- "$OBSIDIAN_VAULT_PATH")"
  if [[ "$vault_path_real" != "$content_state_root_real/"* ]]; then
    echo "Vault path must remain under /var/lib/yubit-academy after resolution: $vault_path_real" >&2
    return 1
  fi
  if sudo test -L "$OBSIDIAN_VAULT_PATH"; then
    echo "Refusing symlinked Obsidian vault path: $OBSIDIAN_VAULT_PATH" >&2
    return 1
  fi
  sudo install -d -m 0750 -o ubuntu -g ubuntu "$OBSIDIAN_VAULT_PATH"
}

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

capture_service_lifecycle_state() {
  local service="$1"
  local state

  state="$(sudo systemctl show "$service" \
    --property=LoadState,ActiveState,SubState \
    --no-pager 2>/dev/null || true)"
  printf '%s\n' "$state" | LC_ALL=C sort
}

if [[ ! -s "$ENV_FILE" ]]; then
  echo "Missing production environment file: $ENV_FILE" >&2
  exit 1
fi
read_production_env() {
  sudo awk -F= -v key="$1" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}
expected_distribution_targets='-1003710405969:8,-1003710405969:10,-1003710405969:16,-1001702053978:309971,-1003332783916:3,-1003332783916:10,-1003332783916:13,-1003332783916:16,-1003332783916:19,-1003332783916:22,-1003332783916:25,-1004458467548:4,-1004458467548:11,-1004458467548:14,-1004458467548:17,-1004458467548:20,-1004458467548:23,-1004458467548:26'
if [[ "$(read_production_env TELEGRAM_DEMO_ONLY)" != "true" \
  || "$(read_production_env TRADING_DEMO_ONLY)" != "true" \
  || "$(read_production_env TELEGRAM_DISTRIBUTION_APPROVED_TARGETS)" != "$expected_distribution_targets" \
  || "$(read_production_env ALLOW_LIVE_TELEGRAM)" == "true" ]]; then
  echo "Production Telegram safety policy must remain locked to the governed internal Topic allowlist." >&2
  exit 1
fi
publisher_config_before="$(sudo grep -E '^(TELEGRAM_|TRADING_DEMO_ONLY|ALLOW_LIVE_TELEGRAM|DISCORD_)=' "$ENV_FILE" | sha256sum | awk '{print $1}')"
deployment_backup_dir="$(mktemp -d)"
sudo cp -a "$ENV_FILE" "$deployment_backup_dir/production.env"
release_env_existed=false
if sudo test -f /etc/yubit-academy/release.env; then
  sudo cp -a /etc/yubit-academy/release.env "$deployment_backup_dir/release.env"
  release_env_existed=true
fi
previous_release=""
if [[ -L "$APP_ROOT/current" ]]; then
  previous_release="$(readlink -f "$APP_ROOT/current" || true)"
fi
configuration_updated=false
activation_started=false
rollback_activation() {
  local exit_code=$?
  trap - EXIT
  rm -f "${primary_env:-}"
  if [[ -n "${env_pending:-}" ]]; then sudo rm -f "$env_pending" || true; fi
  if [[ "$exit_code" == "0" ]]; then
    rm -rf "$deployment_backup_dir"
    return 0
  fi
  echo "Deployment failed; restoring the previous release and environment." >&2
  if [[ "$configuration_updated" == "true" ]]; then
    sudo cp -a "$deployment_backup_dir/production.env" "$ENV_FILE" || true
  fi
  if [[ "$activation_started" == "true" ]]; then
    if [[ -n "$previous_release" && -d "$previous_release" ]]; then
      sudo ln -sfn "$previous_release" "$APP_ROOT/current" || true
      sudo chown -h ubuntu:ubuntu "$APP_ROOT/current" || true
    else
      sudo rm -f "$APP_ROOT/current" || true
    fi
    if [[ "$release_env_existed" == "true" ]]; then
      sudo cp -a "$deployment_backup_dir/release.env" /etc/yubit-academy/release.env || true
    else
      sudo rm -f /etc/yubit-academy/release.env || true
    fi
    sudo systemctl daemon-reload || true
    sudo systemctl restart yubit-academy-web.service || true
  fi
  rm -rf "$deployment_backup_dir"
  exit "$exit_code"
}
trap rollback_activation EXIT
if [[ ! -x "$NODE_HOME/bin/node" ]]; then
  echo "Node runtime not found at $NODE_HOME/bin/node" >&2
  exit 1
fi

if ! command -v psql >/dev/null 2>&1; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y postgresql postgresql-client
fi
sudo systemctl enable --now postgresql
local_database_password="$(sudo awk -F= '$1 == "LOCAL_DATABASE_PASSWORD" { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
if [[ -z "$local_database_password" ]]; then
  local_database_password="$(openssl rand -hex 32)"
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_roles WHERE rolname='$LOCAL_DATABASE_USER'" | grep -qx 1; then
  printf 'CREATE ROLE "%s" LOGIN PASSWORD '\''%s'\'';\n' "$LOCAL_DATABASE_USER" "$local_database_password" \
    | sudo -u postgres psql --set=ON_ERROR_STOP=1
else
  printf 'ALTER ROLE "%s" PASSWORD '\''%s'\'';\n' "$LOCAL_DATABASE_USER" "$local_database_password" \
    | sudo -u postgres psql --set=ON_ERROR_STOP=1
fi
if ! sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='$LOCAL_DATABASE_NAME'" | grep -qx 1; then
  sudo -u postgres createdb --owner="$LOCAL_DATABASE_USER" "$LOCAL_DATABASE_NAME"
fi
local_database_url="postgresql://$LOCAL_DATABASE_USER:$local_database_password@127.0.0.1:5432/$LOCAL_DATABASE_NAME"
local_database_dsn="postgresql://$LOCAL_DATABASE_USER@127.0.0.1:5432/$LOCAL_DATABASE_NAME"
neon_archive_url="$(sudo awk -F= '$1 == "NEON_ARCHIVE_DATABASE_URL" { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
if [[ -z "$neon_archive_url" ]]; then
  candidate_database_url="$(sudo awk -F= '$1 == "DATABASE_URL" { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
  if [[ -n "$candidate_database_url" && "$candidate_database_url" != *"127.0.0.1"* && "$candidate_database_url" != *"localhost"* ]]; then
    neon_archive_url="$candidate_database_url"
  fi
fi

sudo install -d -m 0755 -o ubuntu -g ubuntu "$APP_ROOT/releases"
sudo install -d -m 0750 -o ubuntu -g ubuntu "$STATE_ROOT"
provision_obsidian_vault
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
sudo awk '!/^(JSON_STORE_BACKEND|JSON_STORE_DIRECTORY|OBSIDIAN_VAULT_PATH|DATABASE_URL|POSTGRES_URL|DATABASE_DRIVER|DATABASE_POOL_MAX|LOCAL_DATABASE_PASSWORD|NEON_ARCHIVE_DATABASE_URL)=/' "$ENV_FILE" >"$primary_env"
{
  printf 'JSON_STORE_BACKEND=local\n'
  printf 'JSON_STORE_DIRECTORY=%s\n' "$STATE_ROOT"
  printf 'OBSIDIAN_VAULT_PATH=%s\n' "$OBSIDIAN_VAULT_PATH"
  printf 'DATABASE_URL=%s\n' "$local_database_url"
  printf 'POSTGRES_URL=%s\n' "$local_database_url"
  printf 'DATABASE_DRIVER=pg\n'
  printf 'DATABASE_POOL_MAX=10\n'
  printf 'LOCAL_DATABASE_PASSWORD=%s\n' "$local_database_password"
  if [[ -n "$neon_archive_url" ]]; then
    printf 'NEON_ARCHIVE_DATABASE_URL=%s\n' "$neon_archive_url"
  fi
} >>"$primary_env"
sudo install -m 0600 -o root -g root "$primary_env" "$env_pending"
sudo mv -f "$env_pending" "$ENV_FILE"
configuration_updated=true
rm -f "$primary_env"
env_pending=""
npm ci --no-audit --no-fund
sudo --user=ubuntu env \
  OBSIDIAN_VAULT_PATH="$OBSIDIAN_VAULT_PATH" \
  "$NODE_HOME/bin/node" scripts/initialize-content-vault.mjs
sudo install -d -m 0750 -o ubuntu -g ubuntu "$OBSIDIAN_BACKUP_ROOT"
vault_backup="$OBSIDIAN_BACKUP_ROOT/obsidian-vault-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
sudo --user=ubuntu tar --create --gzip --file "$vault_backup" --directory "$OBSIDIAN_VAULT_PATH" .
sudo --user=ubuntu find "$OBSIDIAN_BACKUP_ROOT" -maxdepth 1 -type f -name 'obsidian-vault-*.tar.gz' -mtime +14 -delete
sudo ENV_FILE="$ENV_FILE" "$NODE_HOME/bin/node" scripts/check-production-database.mjs
distribution_table="$(PGPASSWORD="$local_database_password" psql "$local_database_dsn" -tAc "SELECT to_regclass('public.distribution_rules')")"
rule_count="0"
if [[ -n "${distribution_table//[[:space:]]/}" ]]; then
  rule_count="$(PGPASSWORD="$local_database_password" psql "$local_database_dsn" -tAc "SELECT count(*) FROM distribution_rules")"
fi
restore_snapshot="$STATE_ROOT/backups/distribution-before-disable-current-broadcasts-20260812T091051Z.json"
if [[ "${rule_count//[[:space:]]/}" == "0" && -s "$restore_snapshot" ]]; then
  sudo env \
    DATABASE_URL="$local_database_url" \
    DATABASE_DRIVER=pg \
    RESTORE_DISTRIBUTION_SNAPSHOT="$restore_snapshot" \
    "$NODE_HOME/bin/node" scripts/restore-distribution-snapshot.mjs
fi
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

worker_state_before="$(capture_service_lifecycle_state yubit-academy-worker.service)"
discord_state_before="$(capture_service_lifecycle_state yubit-academy-discord.service)"
delivery_count_before="$(PGPASSWORD="$local_database_password" psql "$local_database_dsn" -tAc "SELECT count(*) FROM distribution_deliveries")"
delivery_count_before="${delivery_count_before//[[:space:]]/}"
if [[ ! "$delivery_count_before" =~ ^[0-9]+$ ]]; then
  echo "Could not establish the pre-activation delivery receipt baseline." >&2
  exit 1
fi

sudo install -m 0644 deploy/systemd/yubit-academy-web.service /etc/systemd/system/yubit-academy-web.service
sudo install -m 0644 deploy/systemd/yubit-academy-postgres-backup.service /etc/systemd/system/yubit-academy-postgres-backup.service
sudo install -m 0644 deploy/systemd/yubit-academy-postgres-backup.timer /etc/systemd/system/yubit-academy-postgres-backup.timer
sudo install -d -m 0750 -o ubuntu -g ubuntu /var/backups/yubit-academy/postgres
release_env="$(mktemp)"
{
  printf 'APP_RELEASE_SHA=%s\n' "$commit"
  printf 'APP_RELEASE_REF=%s\n' "$BRANCH"
  printf 'APP_ENVIRONMENT=production\n'
  printf 'APP_DEPLOYMENT_URL=https://%s\n' "$SERVER_NAME"
  printf 'JSON_STORE_BACKEND=local\n'
  printf 'JSON_STORE_DIRECTORY=%s\n' "$STATE_ROOT"
  printf 'OBSIDIAN_VAULT_PATH=%s\n' "$OBSIDIAN_VAULT_PATH"
} >"$release_env"
activation_started=true
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
sudo systemctl enable --now yubit-academy-postgres-backup.timer
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

worker_state_after="$(capture_service_lifecycle_state yubit-academy-worker.service)"
discord_state_after="$(capture_service_lifecycle_state yubit-academy-discord.service)"
delivery_count_after="$(PGPASSWORD="$local_database_password" psql "$local_database_dsn" -tAc "SELECT count(*) FROM distribution_deliveries")"
delivery_count_after="${delivery_count_after//[[:space:]]/}"
if [[ "$worker_state_after" != "$worker_state_before" || "$discord_state_after" != "$discord_state_before" ]]; then
  echo "No-send deployment did not preserve the worker and Discord runtime state." >&2
  exit 1
fi
if [[ "$delivery_count_after" != "$delivery_count_before" ]]; then
  echo "No-send deployment changed delivery receipt count: $delivery_count_before -> $delivery_count_after" >&2
  exit 1
fi
echo "Deployment mode: no-send"
echo "Runtime services touched by deployment: false"
echo "Delivery receipts created by deployment: 0"
wait_for_service_active yubit-academy-web.service
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
sudo systemctl start yubit-academy-postgres-backup.service
PGPASSWORD="$local_database_password" pg_isready --dbname="$local_database_dsn"
final_rule_count="$(PGPASSWORD="$local_database_password" psql "$local_database_dsn" -tAc "SELECT count(*) FROM distribution_rules")"
if [[ "${final_rule_count//[[:space:]]/}" == "0" ]]; then
  echo "Local PostgreSQL primary contains no distribution rules after restore." >&2
  exit 1
fi
worker_state_after="$(capture_service_lifecycle_state yubit-academy-worker.service)"
discord_state_after="$(capture_service_lifecycle_state yubit-academy-discord.service)"
delivery_count_after="$(PGPASSWORD="$local_database_password" psql "$local_database_dsn" -tAc "SELECT count(*) FROM distribution_deliveries")"
delivery_count_after="${delivery_count_after//[[:space:]]/}"
publisher_config_after="$(sudo grep -E '^(TELEGRAM_|TRADING_DEMO_ONLY|ALLOW_LIVE_TELEGRAM|DISCORD_)=' "$ENV_FILE" | sha256sum | awk '{print $1}')"
if [[ "$publisher_config_after" != "$publisher_config_before" ]]; then
  echo "No-send deployment changed Telegram or Discord configuration." >&2
  exit 1
fi
sudo --user=ubuntu env \
  DEPLOY_NO_SEND="$DEPLOY_NO_SEND" \
  EXPECTED_COMMIT="$commit" \
  APP_RELEASE_SHA="$commit" \
  OBSIDIAN_VAULT_PATH="$OBSIDIAN_VAULT_PATH" \
  DATABASE_URL="$local_database_url" \
  DATABASE_DRIVER=pg \
  TELEGRAM_DEMO_ONLY="$(read_production_env TELEGRAM_DEMO_ONLY)" \
  TRADING_DEMO_ONLY="$(read_production_env TRADING_DEMO_ONLY)" \
  TELEGRAM_DISTRIBUTION_APPROVED_TARGETS="$(read_production_env TELEGRAM_DISTRIBUTION_APPROVED_TARGETS)" \
  ALLOW_LIVE_TELEGRAM="$(read_production_env ALLOW_LIVE_TELEGRAM)" \
  DELIVERY_COUNT_BEFORE="$delivery_count_before" \
  WORKER_STATE_BEFORE="$worker_state_before" \
  WORKER_STATE_AFTER="$worker_state_after" \
  DISCORD_STATE_BEFORE="$discord_state_before" \
  DISCORD_STATE_AFTER="$discord_state_after" \
  "$NODE_HOME/bin/node" scripts/audit-content-production.mjs
sudo systemctl is-active --quiet yubit-academy-postgres-backup.timer
if ! find /var/backups/yubit-academy/postgres -maxdepth 1 -type f -name 'yubit-academy-*.dump' -print -quit | grep -q .; then
  echo "No local PostgreSQL backup was created." >&2
  exit 1
fi
echo "Telegram and Discord configuration: preserved byte-for-byte"
echo "Discord gateway service: preserved without lifecycle commands"
echo "Worker service: preserved without lifecycle commands"
echo "Local PostgreSQL primary: active"
echo "Local PostgreSQL distribution rules: ${final_rule_count//[[:space:]]/}"
echo "Local PostgreSQL daily backup timer: active"

release_prune_find=("$APP_ROOT/releases" -mindepth 1 -maxdepth 1 -type d ! -path "$release")
if [[ -n "$previous_release" && "$previous_release" == "$APP_ROOT/releases/"* ]]; then
  release_prune_find+=(! -path "$previous_release")
fi
find "${release_prune_find[@]}" -printf '%T@ %p\n' \
  | sort -nr | awk 'NR > 2 {sub(/^[^ ]+ /, ""); print}' \
  | xargs -r sudo rm -rf

activation_started=false
configuration_updated=false
trap - EXIT
rm -rf "$deployment_backup_dir"
echo "Deployed $commit to https://$SERVER_NAME"
