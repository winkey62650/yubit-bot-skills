import assert from "node:assert/strict";
import test from "node:test";

import {
  destinationCtaKey,
  hydrateDestinationCtas,
  loadDestinationCtaRegistry,
  saveDestinationCtaRegistry,
} from "../lib/destination-cta.mjs";
import { composeManualMessage } from "../lib/manual-cta.mjs";

function repository() {
  const meta = new Map();
  return {
    async getMeta(key) { return meta.get(key) ?? null; },
    async setMeta(key, value) { meta.set(key, structuredClone(value)); return value; },
  };
}

test("destination CTA is keyed by Telegram group or globally unique Discord channel", () => {
  assert.equal(destinationCtaKey({ platform: "telegram", chatId: "-1001", threadId: 23 }), "telegram:-1001");
  assert.equal(destinationCtaKey({ platform: "telegram", chatId: "-1001", chatType: "channel" }), "telegram:-1001");
  assert.equal(destinationCtaKey({ platform: "discord", guildId: "g1", channelId: "c9" }), "discord:c9");
});

test("one saved Telegram group CTA is applied to every topic in that group", async () => {
  const repo = repository();
  await saveDestinationCtaRegistry(repo, [
    { platform: "telegram", chatId: "-1001", ctaEnabled: true, ctaText: "Join Group", ctaUrl: "https://example.com/group" },
    { platform: "discord", guildId: "g1", channelId: "c9", ctaEnabled: true, ctaText: "Join Discord", ctaUrl: "https://example.com/d" },
  ]);

  const registry = await loadDestinationCtaRegistry(repo);
  assert.equal(registry["telegram:-1001"].ctaText, "Join Group");

  const targets = await hydrateDestinationCtas(repo, [
    { platform: "telegram", chatId: "-1001", threadId: 23, ctaText: "legacy" },
    { platform: "telegram", chatId: "-1001", threadId: 24 },
    { platform: "discord", guildId: "g1", channelId: "c9" },
  ]);
  assert.equal(targets[0].ctaText, "Join Group");
  assert.equal(targets[1].ctaText, "Join Group");
  assert.equal(targets[2].ctaText, "Join Discord");
  assert.equal(targets[0].threadId, 23);
  assert.equal(targets[1].threadId, 24);
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
  assert.equal(targets[0].ctaText, "");
  assert.equal(targets[1].ctaEnabled, false);
  assert.equal(targets[1].ctaText, "");
  assert.equal(composeManualMessage("body", targets[0]), "body");
});

test("legacy Telegram topic CTA records are read as one group CTA", async () => {
  const repo = repository();
  await repo.setMeta("distribution:destination-cta:v1", {
    "telegram:-1001:23": { platform: "telegram", chatId: "-1001", threadId: 23, ctaEnabled: true, ctaText: "Legacy CTA", ctaUrl: "https://example.com/legacy" }
  });

  const registry = await loadDestinationCtaRegistry(repo);
  assert.equal(registry["telegram:-1001"].ctaText, "Legacy CTA");
  assert.equal(registry["telegram:-1001"].threadId, null);
});
