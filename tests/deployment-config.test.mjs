import assert from "node:assert/strict";
import test from "node:test";
import { cronSecretConfig, persistentDatabaseConfig } from "../lib/deployment-config.mjs";

test("hosted Preview requires dedicated database and cron credentials", () => {
  const env = {
    VERCEL: "1",
    VERCEL_ENV: "preview",
    DATABASE_URL: "postgresql://production.invalid/database",
    POSTGRES_URL: "postgresql://production.invalid/postgres",
    CRON_SECRET: "production-cron-secret",
  };

  assert.deepEqual(persistentDatabaseConfig(env), {
    environment: "preview",
    variable: "PREVIEW_DATABASE_URL",
    url: "",
    isolated: false,
  });
  assert.deepEqual(cronSecretConfig(env), {
    environment: "preview",
    variable: "PREVIEW_CRON_SECRET",
    secret: "",
    isolated: false,
  });
});

test("hosted Preview accepts only its explicitly isolated credentials", () => {
  const env = {
    VERCEL: "1",
    VERCEL_ENV: "preview",
    PREVIEW_DATABASE_URL: "postgresql://preview.invalid/database",
    PREVIEW_CRON_SECRET: "preview-cron-secret",
  };

  assert.equal(persistentDatabaseConfig(env).url, env.PREVIEW_DATABASE_URL);
  assert.equal(persistentDatabaseConfig(env).isolated, true);
  assert.equal(cronSecretConfig(env).secret, env.PREVIEW_CRON_SECRET);
  assert.equal(cronSecretConfig(env).isolated, true);
});

test("production continues to require the production cron secret", () => {
  const config = cronSecretConfig({
    VERCEL: "1",
    VERCEL_ENV: "production",
    CRON_SECRET: "production-cron-secret",
    PREVIEW_CRON_SECRET: "preview-cron-secret",
  });

  assert.equal(config.variable, "CRON_SECRET");
  assert.equal(config.secret, "production-cron-secret");
  assert.equal(config.isolated, true);
});
