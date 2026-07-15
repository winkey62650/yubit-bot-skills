import { reconcileDistributionRouting } from "../lib/distribution-domain.mjs";
import { getDistributionRepository } from "../lib/distribution-repository.mjs";
import { readJson, writeJson } from "../lib/json-store.js";

const DEMO_CHAT_ID = String(process.env.DEMO_CHAT_ID || "-1003710405969");
const EXPECTED_THREAD_IDS = [6, 8, 10, 12, 14, 16, 18];
const dryRun = process.env.DRY_RUN !== "false";

function topicSequence(value) {
  const match = String(value ?? "").replace(/^[^\p{L}\p{N}]+/gu, "").match(/^(\d+)\s*[.、)]/);
  return match ? Number(match[1]) : null;
}

function repairGroupDocument(document) {
  let changed = false;
  const groups = (Array.isArray(document?.groups) ? document.groups : []).map((group) => {
    if (String(group?.chatId ?? group?.id ?? "") !== DEMO_CHAT_ID) return group;
    const topics = (Array.isArray(group.topics) ? group.topics : []).map((topic) => {
      const sequence = topicSequence(topic.name ?? topic.title);
      const expectedThreadId = EXPECTED_THREAD_IDS[sequence - 1];
      if (!expectedThreadId) return topic;
      if (Number(topic.threadId ?? topic.topicId ?? topic.id) !== expectedThreadId || topic.verified !== true) changed = true;
      return {
        ...topic,
        id: expectedThreadId,
        threadId: expectedThreadId,
        source: "telegram-confirmed",
        verified: true
      };
    });
    const detectedTopicThreadIds = [...EXPECTED_THREAD_IDS];
    if (JSON.stringify(group.detectedTopicThreadIds ?? []) !== JSON.stringify(detectedTopicThreadIds)) changed = true;
    return {
      ...group,
      topics,
      detectedTopicThreadIds,
      topicCoverage: {
        knownCount: topics.length,
        resolvedCount: topics.filter((topic) => Number(topic.threadId) > 0).length,
        detectedThreadCount: detectedTopicThreadIds.length,
        complete: topics.length > 0 && topics.every((topic) => Number(topic.threadId) > 0)
      },
      source: "telegram-confirmed"
    };
  });
  return { changed, value: { ...document, groups, updatedAt: new Date().toISOString() } };
}

async function main() {
  const [groupConfig, registry, repository] = await Promise.all([
    readJson("group-config.json", { groups: [] }),
    readJson("telegram-group-registry.json", { groups: [] }),
    getDistributionRepository()
  ]);
  const repairedConfig = repairGroupDocument(groupConfig);
  const repairedRegistry = repairGroupDocument(registry);
  const rules = await repository.listRules();
  const repairedRules = rules.map((rule) => reconcileDistributionRouting(rule, repairedConfig.value.groups));
  const changedRules = repairedRules.filter((rule, index) => JSON.stringify(rule) !== JSON.stringify(rules[index]));
  const summary = {
    dryRun,
    demoChatId: DEMO_CHAT_ID,
    groupConfigChanged: repairedConfig.changed,
    registryChanged: repairedRegistry.changed,
    changedRules: changedRules.map((rule) => ({
      id: rule.id,
      kind: rule.kind,
      name: rule.name,
      sourceThreadId: rule.source?.threadId ?? null,
      demoTargetThreadIds: rule.targets.filter((target) => target.chatId === DEMO_CHAT_ID).map((target) => target.threadId)
    }))
  };

  if (!dryRun) {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    await Promise.all([
      writeJson(`backups/topic-routing-${stamp}-group-config.json`, groupConfig),
      writeJson(`backups/topic-routing-${stamp}-registry.json`, registry),
      repository.setMeta(`topic-routing-backup-${stamp}`, {
        createdAt: new Date().toISOString(),
        chatId: DEMO_CHAT_ID,
        rules: rules.filter((rule) => rule.source?.chatId === DEMO_CHAT_ID || rule.targets.some((target) => target.chatId === DEMO_CHAT_ID))
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
