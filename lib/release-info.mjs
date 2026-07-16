export const RELEASE_SCHEMA_VERSION = "2026-07-16.trading-center.v1";

export const RELEASE_CAPABILITIES = Object.freeze([
  "content-distribution",
  "telegram-broadcast",
  "multi-trader-trading-center",
]);

function deploymentUrl(value) {
  const normalized = String(value || "").trim();
  if (!normalized) return null;
  return /^https?:\/\//iu.test(normalized) ? normalized : `https://${normalized}`;
}

export function buildReleaseInfo(env = process.env) {
  return {
    ok: true,
    schemaVersion: RELEASE_SCHEMA_VERSION,
    commitSha: String(env.VERCEL_GIT_COMMIT_SHA || "local").trim() || "local",
    gitRef: String(env.VERCEL_GIT_COMMIT_REF || "local").trim() || "local",
    environment: String(env.VERCEL_ENV || "local").trim() || "local",
    deploymentUrl: deploymentUrl(env.VERCEL_URL),
    capabilities: RELEASE_CAPABILITIES,
  };
}
