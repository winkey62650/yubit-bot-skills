import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  destinationCtaKey,
  hydrateDestinationCtas,
  loadDestinationCtaRegistry,
  mergeDestinationCtaConfigs,
  saveDestinationCtaConfig,
  saveDestinationCtaRegistry,
  requireSavedMarketEventCtas,
} from "../lib/destination-cta.mjs";
import { composeManualMessage } from "../lib/manual-cta.mjs";
import {
  buildAutomationDiscordPlans,
  buildAutomationTelegramPlans,
} from "../lib/automation-jobs.mjs";

function repository() {
  const meta = new Map();
  return {
    async getMeta(key) { return meta.get(key) ?? null; },
    async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
  };
}

test("destination CTA API bulk saves merge instead of replacing the registry", async () => {
  const routeSource = await readFile(new URL("../app/api/destination-cta/route.js", import.meta.url), "utf8");
  assert.match(routeSource, /mergeDestinationCtaConfigs\(repository, body\.configs\)/);
  assert.doesNotMatch(routeSource, /saveDestinationCtaRegistry\(repository, body\.configs\)/);
});

test("destination CTA is keyed by Telegram group or Discord server", () => {
  assert.equal(destinationCtaKey({ platform: "telegram", chatId: "-1001", threadId: 23 }), "telegram:-1001");
  assert.equal(destinationCtaKey({ platform: "telegram", chatId: "-1001", chatType: "channel" }), "telegram:-1001");
  assert.equal(destinationCtaKey({ platform: "discord", guildId: "g1", channelId: "c9" }), "discord:g1");
});

test("destination CTA persists one formatted content field and migrates legacy split fields", async () => {
  const repo = repository();
  await saveDestinationCtaConfig(repo, {
    platform: "telegram",
    chatId: "-1001",
    ctaEnabled: true,
    ctaContent: "**Join YUBIT**\n\n[Open community](https://example.com/join)",
  });
  await repo.setMeta("distribution:destination-cta:v1", {
    ...(await repo.getMeta("distribution:destination-cta:v1")),
    "discord:g1": {
      platform: "discord",
      guildId: "g1",
      ctaEnabled: true,
      ctaText: "Legacy Discord",
      ctaUrl: "https://example.com/legacy",
    },
  });

  const registry = await loadDestinationCtaRegistry(repo);
  assert.equal(registry["telegram:-1001"].ctaContent, "**Join YUBIT**\n\n[Open community](https://example.com/join)");
  assert.equal(registry["discord:g1"].ctaContent, "Legacy Discord\nhttps://example.com/legacy");
  assert.equal("ctaText" in registry["telegram:-1001"], false);
  assert.equal("ctaUrl" in registry["telegram:-1001"], false);
  assert.equal("ctaText" in registry["discord:g1"], false);
  assert.equal("ctaUrl" in registry["discord:g1"], false);
});

test("one saved group or server CTA is applied without changing topic or channel routing", async () => {
  const repo = repository();
  await saveDestinationCtaRegistry(repo, [
    { platform: "telegram", chatId: "-1001", ctaEnabled: true, ctaText: "Join Group", ctaUrl: "https://example.com/group" },
    { platform: "discord", guildId: "g1", ctaEnabled: true, ctaText: "Join Discord", ctaUrl: "https://example.com/d" },
  ]);

  const registry = await loadDestinationCtaRegistry(repo);
  assert.equal(registry["telegram:-1001"].ctaContent, "Join Group\nhttps://example.com/group");

  const targets = await hydrateDestinationCtas(repo, [
    { platform: "telegram", chatId: "-1001", threadId: 23, ctaText: "legacy" },
    { platform: "telegram", chatId: "-1001", threadId: 24 },
    { platform: "discord", guildId: "g1", channelId: "c9" },
    { platform: "discord", guildId: "g1", channelId: "c10" },
  ]);
  assert.equal(targets[0].ctaContent, "Join Group\nhttps://example.com/group");
  assert.equal(targets[1].ctaContent, "Join Group\nhttps://example.com/group");
  assert.equal(targets[2].ctaContent, "Join Discord\nhttps://example.com/d");
  assert.equal(targets[3].ctaContent, "Join Discord\nhttps://example.com/d");
  assert.equal(targets[0].threadId, 23);
  assert.equal(targets[1].threadId, 24);
  assert.equal(targets[2].channelId, "c9");
  assert.equal(targets[3].channelId, "c10");
  assert.equal(composeManualMessage("Manual body", targets[0]), "Manual body\n\nJoin Group\nhttps://example.com/group");
  assert.equal(composeManualMessage("Discord body", targets[2]), "Discord body\n\nJoin Discord\nhttps://example.com/d");
});

test("saving one destination CTA preserves CTA configs for other groups and servers", async () => {
  const repo = repository();
  await saveDestinationCtaRegistry(repo, [
    { platform: "telegram", chatId: "-1001", ctaEnabled: true, ctaText: "Group One", ctaUrl: "https://example.com/one" },
    { platform: "discord", guildId: "g1", ctaEnabled: true, ctaText: "Discord One", ctaUrl: "https://example.com/d" },
  ]);

  const registry = await saveDestinationCtaConfig(repo, {
    platform: "telegram",
    chatId: "-1002",
    ctaEnabled: true,
    ctaText: "Group Two",
    ctaUrl: "https://example.com/two",
  });

  assert.equal(registry["telegram:-1001"].ctaContent, "Group One\nhttps://example.com/one");
  assert.equal(registry["telegram:-1002"].ctaContent, "Group Two\nhttps://example.com/two");
  assert.equal(registry["discord:g1"].ctaContent, "Discord One\nhttps://example.com/d");
});

test("bulk CTA save merges drafts and cannot erase a previously saved channel", async () => {
  const repo = repository();
  await saveDestinationCtaConfig(repo, {
    platform: "telegram",
    chatId: "-1001",
    ctaEnabled: true,
    ctaText: "Demo CTA",
    ctaUrl: "https://example.com/demo",
  });

  await mergeDestinationCtaConfigs(repo, []);
  await mergeDestinationCtaConfigs(repo, [{
    platform: "discord",
    guildId: "g1",
    ctaEnabled: true,
    ctaText: "Discord CTA",
    ctaUrl: "https://example.com/discord",
  }]);

  const registry = await loadDestinationCtaRegistry(repo);
  assert.equal(registry["telegram:-1001"].ctaContent, "Demo CTA\nhttps://example.com/demo");
  assert.equal(registry["discord:g1"].ctaContent, "Discord CTA\nhttps://example.com/discord");

  const [target] = await hydrateDestinationCtas(repo, [
    { platform: "telegram", chatId: "-1001", threadId: 23 },
  ]);
  assert.equal(
    composeManualMessage("Manual body", target),
    "Manual body\n\nDemo CTA\nhttps://example.com/demo"
  );
});

test("an explicitly disabled Telegram group overrides legacy rule CTA for every topic", async () => {
  const repo = repository();
  await saveDestinationCtaRegistry(repo, [
    { platform: "telegram", chatId: "-1001", ctaEnabled: false, ctaText: "", ctaUrl: "" },
  ]);
  const targets = await hydrateDestinationCtas(repo, [
    { platform: "telegram", chatId: "-1001", threadId: 23, ctaEnabled: true, ctaText: "legacy one" },
    { platform: "telegram", chatId: "-1001", threadId: 24, ctaEnabled: true, ctaText: "legacy two" },
  ]);
  assert.equal(targets[0].ctaEnabled, false);
  assert.equal(targets[0].ctaContent, "");
  assert.equal(targets[1].ctaEnabled, false);
  assert.equal(targets[1].ctaContent, "");
  assert.equal(composeManualMessage("body", targets[0]), "body");
});

test("an unconfigured destination cannot preserve an inline legacy or backend CTA", async () => {
  const repo = repository();
  const [target] = await hydrateDestinationCtas(repo, [{
    platform: "telegram",
    chatId: "-1009",
    ctaEnabled: true,
    ctaText: "Open dashboard",
    ctaUrl: "https://internal.example/academy",
    ctaContent: "Open dashboard\nhttps://internal.example/academy",
  }]);

  assert.equal("ctaEnabled" in target, false);
  assert.equal("ctaContent" in target, false);
  assert.equal("ctaSource" in target, false);
  assert.equal("ctaText" in target, false);
  assert.equal("ctaUrl" in target, false);
});

test("Market Events require one enabled saved CTA for every target", () => {
  const ready = [{ platform: "telegram", chatId: "-1001", ctaEnabled: true, ctaContent: "Join", ctaSource: "destination-registry" }];
  assert.equal(requireSavedMarketEventCtas("weekly-calendar", ready), ready);
  assert.throws(
    () => requireSavedMarketEventCtas("crypto-daily", [{ platform: "telegram", chatId: "-1002", ctaSource: "missing" }]),
    /MARKET_EVENTS_DESTINATION_CTA_REQUIRED/,
  );
  assert.throws(
    () => requireSavedMarketEventCtas("data-release-updates", [{ platform: "telegram", chatId: "-1002", ctaEnabled: false, ctaContent: "", ctaSource: "missing" }]),
    /MARKET_EVENTS_DESTINATION_CTA_REQUIRED/,
  );
  const unrelated = [{ platform: "telegram", chatId: "-1002", ctaSource: "missing" }];
  assert.equal(requireSavedMarketEventCtas("agent-sync-4h", unrelated), unrelated);
});

test("legacy Telegram topic CTA records are read as one group CTA", async () => {
  const repo = repository();
  await repo.setMeta("distribution:destination-cta:v1", {
    "telegram:-1001:23": { platform: "telegram", chatId: "-1001", threadId: 23, ctaEnabled: true, ctaText: "Legacy CTA", ctaUrl: "https://example.com/legacy" }
  });

  const registry = await loadDestinationCtaRegistry(repo);
  assert.equal(registry["telegram:-1001"].ctaContent, "Legacy CTA\nhttps://example.com/legacy");
  assert.equal(registry["telegram:-1001"].threadId, null);
});

test("legacy Discord channel CTA records are read as one server CTA", async () => {
  const repo = repository();
  await repo.setMeta("distribution:destination-cta:v1", {
    "discord:channel-9": { platform: "discord", guildId: "guild-1", channelId: "channel-9", ctaEnabled: true, ctaText: "Legacy Discord CTA", ctaUrl: "https://example.com/legacy" }
  });

  const registry = await loadDestinationCtaRegistry(repo);
  assert.equal(registry["discord:guild-1"].ctaContent, "Legacy Discord CTA\nhttps://example.com/legacy");
  assert.equal(registry["discord:guild-1"].channelId, "");
});

test("market send plans hydrate the latest rich CTA once per Telegram group and Discord guild", async () => {
  const repo = repository();
  await saveDestinationCtaRegistry(repo, [
    { platform: "telegram", chatId: "-1001", ctaEnabled: true, ctaContent: "**Stale TG CTA**" },
    { platform: "discord", guildId: "g1", ctaEnabled: true, ctaContent: "**Stale DC CTA**" },
  ]);
  await saveDestinationCtaConfig(repo, {
    platform: "telegram",
    chatId: "-1001",
    ctaEnabled: true,
    ctaContent: "**Latest TG CTA**\n[Join TG](https://example.com/tg?a=1&b=2)",
  });
  await saveDestinationCtaConfig(repo, {
    platform: "discord",
    guildId: "g1",
    ctaEnabled: true,
    ctaContent: "**Latest DC CTA**\n[Join DC](https://example.com/dc?a=1&b=2)",
  });

  const registry = await loadDestinationCtaRegistry(repo);
  assert.deepEqual(Object.keys(registry).sort(), ["discord:g1", "telegram:-1001"]);

  const targets = await hydrateDestinationCtas(repo, [
    { platform: "telegram", chatId: "-1001", threadId: 7 },
    { platform: "telegram", chatId: "-1001", threadId: 8 },
    { platform: "discord", guildId: "g1", channelId: "c1" },
    { platform: "discord", guildId: "g1", channelId: "c2" },
  ]);
  const document = {
    templateId: "crypto-daily",
    nodes: [{ type: "heading", text: "Verified market update" }],
  };
  const telegramPlans = buildAutomationTelegramPlans("crypto-daily", { document }, targets);
  const discordPlans = buildAutomationDiscordPlans("crypto-daily", { document }, targets);

  assert.deepEqual(telegramPlans.map((plan) => plan.target.threadId), [7, 8]);
  assert.deepEqual(discordPlans.map((plan) => plan.target.channelId), ["c1", "c2"]);
  for (const plan of telegramPlans) {
    const payload = plan.steps.at(-1).payload.text;
    assert.match(payload, /<b>Latest TG CTA<\/b>/);
    assert.match(payload, /<a href="https:\/\/example\.com\/tg\?a=1&amp;b=2">Join TG<\/a>/);
    assert.doesNotMatch(payload, /Stale TG CTA/);
  }
  for (const plan of discordPlans) {
    const payload = plan.steps.at(-1).payload.content;
    assert.match(payload, /\*\*Latest DC CTA\*\*/);
    assert.match(payload, /\[Join DC\]\(https:\/\/example\.com\/dc\?a=1&b=2\)/);
    assert.doesNotMatch(payload, /Stale DC CTA/);
  }
});
