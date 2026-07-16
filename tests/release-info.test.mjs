import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  RELEASE_CAPABILITIES,
  RELEASE_SCHEMA_VERSION,
  buildReleaseInfo,
} from "../lib/release-info.mjs";

const root = new URL("../", import.meta.url);
const require = createRequire(import.meta.url);
const {
  REQUIRED_RELEASE_CAPABILITIES,
  REQUIRED_RELEASE_SCHEMA_VERSION,
} = require("../lib/release-gate.cjs");

test("release info exposes safe immutable deployment metadata", () => {
  assert.equal(RELEASE_SCHEMA_VERSION, "2026-07-16.trading-center.v1");
  assert.deepEqual(RELEASE_CAPABILITIES, [
    "content-distribution",
    "telegram-broadcast",
    "multi-trader-trading-center",
  ]);
  assert.deepEqual(buildReleaseInfo({
    VERCEL_GIT_COMMIT_SHA: "abcdef123456",
    VERCEL_GIT_COMMIT_REF: "code/academy",
    VERCEL_ENV: "preview",
    VERCEL_URL: "academy-preview.vercel.app",
    AUTH_PASSWORD: "must-not-leak",
  }), {
    ok: true,
    schemaVersion: RELEASE_SCHEMA_VERSION,
    commitSha: "abcdef123456",
    gitRef: "code/academy",
    environment: "preview",
    deploymentUrl: "https://academy-preview.vercel.app",
    capabilities: RELEASE_CAPABILITIES,
  });
});

test("release endpoint and release gate share the same fingerprint contract", () => {
  assert.equal(REQUIRED_RELEASE_SCHEMA_VERSION, RELEASE_SCHEMA_VERSION);
  assert.deepEqual(REQUIRED_RELEASE_CAPABILITIES, RELEASE_CAPABILITIES);
});

test("release info has explicit local fallbacks and never serializes secrets", () => {
  const payload = buildReleaseInfo({ AUTH_PASSWORD: "must-not-leak" });
  assert.equal(payload.commitSha, "local");
  assert.equal(payload.gitRef, "local");
  assert.equal(payload.environment, "local");
  assert.equal(payload.deploymentUrl, null);
  assert.doesNotMatch(JSON.stringify(payload), /must-not-leak|AUTH_PASSWORD/);
});

test("release info API is dynamic and delegates to the safe metadata builder", async () => {
  const route = await readFile(new URL("app/api/release-info/route.js", root), "utf8");
  assert.match(route, /export const dynamic = "force-dynamic"/);
  assert.match(route, /buildReleaseInfo\(process\.env\)/);
  assert.doesNotMatch(route, /AUTH_PASSWORD|DATABASE_URL|BOT_TOKEN/);
});
