import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (pathname) => readFileSync(new URL(pathname, root), "utf8");

test("production deploy provisions a local primary and preserves the Neon archive URL", () => {
  const deploy = read("deploy/server/deploy.sh");
  assert.match(deploy, /apt-get install -y postgresql postgresql-client/);
  assert.match(deploy, /DATABASE_DRIVER=pg/);
  assert.match(deploy, /NEON_ARCHIVE_DATABASE_URL/);
  assert.match(deploy, /restore-distribution-snapshot\.mjs/);
  assert.match(deploy, /distribution-before-disable-current-broadcasts-20260812T091051Z\.json/);
  assert.doesNotMatch(deploy, /psql "\$local_database_url"/);
});

test("production deploy installs a persistent daily PostgreSQL backup timer", () => {
  const deploy = read("deploy/server/deploy.sh");
  const service = read("deploy/systemd/yubit-academy-postgres-backup.service");
  const timer = read("deploy/systemd/yubit-academy-postgres-backup.timer");
  assert.match(deploy, /enable --now yubit-academy-postgres-backup\.timer/);
  assert.match(service, /backup-production-postgres\.sh/);
  assert.match(timer, /OnCalendar=.*Asia\/Shanghai/);
  assert.ok(existsSync(new URL("scripts/backup-production-postgres.sh", root)));
  assert.ok((statSync(new URL("scripts/backup-production-postgres.sh", root)).mode & 0o111) !== 0);
});
