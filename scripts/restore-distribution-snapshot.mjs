import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { PostgresDistributionRepository } from "../lib/distribution-repository.mjs";

export async function restoreDistributionSnapshot({
  repository,
  snapshot,
  sourceName = "unknown",
  restoredAt = new Date().toISOString(),
}) {
  if (!Array.isArray(snapshot?.rules) || snapshot.rules.length === 0) {
    throw new Error("Distribution snapshot contains no rules");
  }
  await repository.initialize();
  const existing = await repository.listRules();
  if (existing.length > 0) {
    throw new Error("Local primary database already contains distribution rules; refusing to overwrite it");
  }
  for (const rule of snapshot.rules) await repository.saveRule(rule);
  const deliveries = Array.isArray(snapshot.deliveries) ? snapshot.deliveries : [];
  await repository.setMeta("restore:distribution-snapshot-v1", {
    sourceName,
    restoredAt,
    restoredRuleIds: snapshot.rules.map((rule) => rule.id),
    archivedDeliveries: deliveries,
  });
  return { restoredRules: snapshot.rules.length, archivedDeliveries: deliveries.length };
}

async function main() {
  const databaseUrl = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  const snapshotPath = process.env.RESTORE_DISTRIBUTION_SNAPSHOT;
  if (!databaseUrl) throw new Error("DATABASE_URL or POSTGRES_URL must be configured");
  if (!snapshotPath) throw new Error("RESTORE_DISTRIBUTION_SNAPSHOT must be configured");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const repository = new PostgresDistributionRepository(databaseUrl);
  try {
    const result = await restoreDistributionSnapshot({ repository, snapshot, sourceName: basename(snapshotPath) });
    console.log(`Distribution snapshot restored: ${result.restoredRules} rules; ${result.archivedDeliveries} deliveries archived`);
  } finally {
    await repository.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
