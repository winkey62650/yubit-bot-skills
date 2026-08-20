#!/usr/bin/env bash
set -Eeuo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/yubit-academy/postgres}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
database_url="${DATABASE_URL:-${POSTGRES_URL:-}}"
if [[ -z "$database_url" ]]; then
  echo "DATABASE_URL or POSTGRES_URL must be configured" >&2
  exit 1
fi

install -d -m 0750 "$BACKUP_ROOT"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
pending="$BACKUP_ROOT/yubit-academy-$stamp.dump.pending"
output="$BACKUP_ROOT/yubit-academy-$stamp.dump"
pg_dump --dbname="$database_url" --format=custom --no-owner --no-acl --file="$pending"
mv "$pending" "$output"
sha256sum "$output" >"$output.sha256"
find "$BACKUP_ROOT" -type f -mtime "+$RETENTION_DAYS" -delete
echo "PostgreSQL backup written: $output"
