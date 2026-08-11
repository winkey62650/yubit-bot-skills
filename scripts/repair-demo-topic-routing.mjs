import { reconcileDistributionRouting } from "../lib/distribution-domain.mjs";
import { getDistributionRepository } from "../lib/distribution-repository.mjs";
import { readJson, writeJson } from "../lib/json-store.js";
import {
  CANONICAL_TOPIC_ROUTES,
  repairCanonicalTopicRouting
} from "../lib/canonical-topic-routing.mjs";

const CANONICAL_CHAT_IDS = Object.keys(CANONICAL_TOPIC_ROUTES);
const dryRun = process.env.DRY_RUN !== "false";

async function main() {
  const [groupConfig, registry, repository] = await Promise.all([
    readJson("group-config.json", { groups: [] }),
    readJson("telegram-group-registry.json", { groups: [] }),
    getDistributionRepository()
  ]);
  const repairedConfig = repairCanonicalTopicRouting(groupConfig);
  const repairedRegistry = repairCanonicalTopicRouting(registry);
  const rules = await repository.listRules();
  const repairedRules = rules.map((rule) => reconcileDistributionRouting(rule, repairedConfig.value.groups));
  const changedRules = repairedRules.filter((rule, index) => JSON.stringify(rule) !== JSON.stringify(rules[index]));
  const summary = {
    dryRun,
    canonicalChatIds: CANONICAL_CHAT_IDS,
    groupConfigChanged: repairedConfig.changed,
    registryChanged: repairedRegistry.changed,
    changedRules: changedRules.map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      name: rule.name,
      sourceThreadId: rule.source?.threadId ?? null,
      canonicalTargets: rule.targets
        .filter((target) => CANONICAL_CHAT_IDS.includes(target.chatId))
        .map((target) => ({ chatId: target.chatId, threadId: target.threadId }))
    }))
  };

  if (!dryRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await Promise.all([
      writeJson(`backups/topic-routing-${stamp}-group-config.json`, groupConfig),
      writeJson(`backups/topic-routing-${stamp}-registry.json`, registry),
      repository.setMeta(`topic-routing-backup-${stamp}`, {
        createdAt: new Date().toISOString(),
        chatIds: CANONICAL_CHAT_IDS,
        rules: rules.filter((rule) => CANONICAL_CHAT_IDS.includes(rule.source?.chatId) || rule.targets.some((target) => CANONICAL_CHAT_IDS.includes(target.chatId)))
      })
    ]);
    await Promise.all([
      writeJson("group-config.json", repairedConfig.value),
      writeJson("telegram-group-registry.json", repairedRegistry.value)
    ]);
    for (const rule of changedRules) await repository.saveRule(rule);
  }

  console.log(JSON.stringify(summary, null, 2));
}

await main();
