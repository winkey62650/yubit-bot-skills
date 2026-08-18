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

test("destination CTA is keyed by Telegram topic or globally unique Discord channel", () => {
  assert.equal(destinationCtaKey({ platform: "telegram", chatId: "-1001", threadId: 23 }), "telegram:-1001:23");
  assert.equal(destinationCtaKey({ platform: "telegram", chatId: "-1001", chatType: "channel" }), "telegram:-1001:channel");
  assert.equal(destinationCtaKey({ platform: "discord", guildId: "g1", channelId: "c9" }), "discord:c9");
});

test("saved destination CTA is loaded and applied independently to every target", async () => {
  const repo = repository();
  await saveDestinationCtaRegistry(repo, [
    { platform: "telegram", chatId: "-1001", threadId: 23, ctaEnabled: true, ctaText: "Join Topic 23", ctaUrl: "https://example.com/t23" },
    { platform: "discord", guildId: "g1", channelId: "c9", ctaEnabled: true, ctaText: "Join Discord", ctaUrl: "https://example.com/d" },
  ]);

  const registry = await loadDestinationCtaRegistry(repo);
  assert.equal(registry["telegram:-1001:23"].ctaText, "Join Topic 23");

  const targets = await hydrateDestinationCtas(repo, [
    { platform: "telegram", chatId: "-1001", threadId: 23, ctaText: "legacy" },
    { platform: "discord", guildId: "g1", channelId: "c9" },
  ]);
  assert.equal(targets[0].ctaText, "Join Topic 23");
  assert.equal(targets[1].ctaText, "Join Discord");
});

test("an explicitly disabled destination overrides legacy rule CTA while missing config falls back", async () => {
  const repo = repository();
  await saveDestinationCtaRegistry(repo, [
    { platform: "telegram", chatId: "-1001", threadId: 23, ctaEnabled: false, ctaText: "", ctaUrl: "" },
  ]);
  const targets = await hydrateDestinationCtas(repo, [
    { platform: "telegram", chatId: "-1001", threadId: 23, ctaEnabled: true, ctaText: "legacy one" },
    { platform: "telegram", chatId: "-1001", threadId: 24, ctaEnabled: true, ctaText: "legacy two" },
  ]);
  assert.equal(targets[0].ctaEnabled, false);
  assert.equal(targets[0].ctaText, "");
  assert.equal(targets[1].ctaText, "legacy two");
  assert.equal(composeManualMessage("body", targets[0]), "body");
});
