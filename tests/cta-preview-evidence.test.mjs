import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
  assertStrongCtaPreviewEvidenceSecret,
  signCtaPreviewPlans,
  verifyCtaPreviewBoundary,
} = require("../lib/cta-preview-evidence.cjs");

function fixture(platform = "telegram") {
  const discord = platform === "discord";
  const field = discord ? "content" : "text";
  const payload = discord ? "Market\n\n**Join**" : "Market\n\n<b>Join</b>";
  const start = payload.indexOf(discord ? "**Join**" : "<b>Join</b>");
  return [{
    target: discord
      ? { platform, guildId: "guild-1", channelId: "channel-1" }
      : { platform, chatId: "-1001", threadId: 8 },
    steps: [{
      method: "sendMessage",
      payload: discord
        ? { [field]: payload }
        : { chat_id: "-1001", message_thread_id: 8, [field]: payload },
      ctaBoundary: {
        kind: "destination-cta",
        placement: "suffix",
        platform,
        method: "sendMessage",
        field,
        start,
        end: payload.length,
        stepIndex: 0,
        stepCount: 1,
      },
    }],
  }];
}

test("CTA preview evidence binds the challenge, destination, payload, CTA and exact final send step", () => {
  const secret = randomBytes(32).toString("hex");
  const challenge = randomBytes(32).toString("base64url");
  for (const platform of ["telegram", "discord"]) {
    const [plan] = signCtaPreviewPlans(fixture(platform), { secret, challenge });
    const step = plan.steps[0];
    assert.equal(verifyCtaPreviewBoundary({
      plan,
      step,
      stepIndex: 0,
      stepCount: 1,
      secret,
      challenge,
    }), true);
    assert.equal(JSON.stringify(plan).includes(secret), false);

    for (const mutate of [
      (copy) => { copy.steps[0].payload[copy.steps[0].ctaBoundary.field] += "!"; },
      (copy) => { copy.steps[0].ctaBoundary.start -= 1; },
      (copy) => { copy.steps[0].ctaBoundary.method = "sendPhoto"; },
      (copy) => { copy.target[platform === "discord" ? "channelId" : "threadId"] = "other"; },
      (copy) => { copy.steps[0].ctaBoundary.evidence.signature = "forged"; },
    ]) {
      const copy = structuredClone(plan);
      mutate(copy);
      assert.equal(verifyCtaPreviewBoundary({
        plan: copy,
        step: copy.steps[0],
        stepIndex: 0,
        stepCount: 1,
        secret,
        challenge,
      }), false);
    }
    assert.equal(verifyCtaPreviewBoundary({
      plan,
      step,
      stepIndex: 0,
      stepCount: 1,
      secret,
      challenge: `${challenge}x`,
    }), false);
  }
});

test("CTA preview evidence fails closed without a strong operational secret or valid challenge", () => {
  const challenge = randomBytes(32).toString("base64url");
  for (const secret of [
    "short",
    " ".repeat(40),
    "a".repeat(32),
    "ab".repeat(16),
    `${"a".repeat(24)}bcdefghi`,
    "password".repeat(4),
    "abcdefghijklmnopqrstuvwxyz123456",
    "0123456789abcdefghijklmnopqrstuv",
    "CorrectHorseBatteryStaple!12345678",
    "this-is-a-public-demo-secret-12345",
    "12345678901234567890123456789012",
    "abcdefghijklmnopqrstuvwxyzABCDEF",
    "0".repeat(64),
    "f".repeat(64),
    "deadbeef".repeat(8),
    "0123456789abcdef".repeat(4),
    `${"a".repeat(64)}\nINJECTED=value`,
    randomBytes(32).toString("hex").toUpperCase(),
  ]) {
    assert.throws(
      () => signCtaPreviewPlans(fixture(), { secret, challenge }),
      (error) => error instanceof Error
        && /CTA_PREVIEW_EVIDENCE_SECRET/.test(error.message)
        && !error.message.includes(secret),
    );
  }
  for (let index = 0; index < 32; index += 1) {
    assert.doesNotThrow(() => assertStrongCtaPreviewEvidenceSecret(randomBytes(32).toString("hex")));
  }
  assert.throws(() => signCtaPreviewPlans(fixture(), { secret: randomBytes(32).toString("hex"), challenge: "predictable" }), /preview challenge/);
});

test("CTA preview evidence binds the canonical full payload while ignoring object key order", () => {
  const secret = randomBytes(32).toString("hex");
  const challenge = randomBytes(32).toString("base64url");

  for (const platform of ["telegram", "discord"]) {
    const plans = fixture(platform);
    plans[0].steps[0].payload = platform === "telegram"
      ? {
          text: plans[0].steps[0].payload.text,
          parse_mode: "HTML",
          link_preview_options: { prefer_small_media: true, is_disabled: false },
          message_thread_id: 8,
          chat_id: "-1001",
        }
      : {
          content: plans[0].steps[0].payload.content,
          allowed_mentions: { parse: [], replied_user: false },
        };
    const [signed] = signCtaPreviewPlans(plans, { secret, challenge });
    const reordered = structuredClone(signed);
    reordered.steps[0].payload = platform === "telegram"
      ? {
          link_preview_options: { is_disabled: false, prefer_small_media: true },
          parse_mode: "HTML",
          text: reordered.steps[0].payload.text,
          chat_id: "-1001",
          message_thread_id: 8,
        }
      : {
          allowed_mentions: { replied_user: false, parse: [] },
          content: reordered.steps[0].payload.content,
        };
    assert.equal(verifyCtaPreviewBoundary({
      plan: reordered,
      step: reordered.steps[0],
      stepIndex: 0,
      stepCount: 1,
      secret,
      challenge,
    }), true);

    const mutated = structuredClone(signed);
    if (platform === "telegram") mutated.steps[0].payload.parse_mode = "MarkdownV2";
    else mutated.steps[0].payload.allowed_mentions.parse = ["everyone"];
    assert.equal(verifyCtaPreviewBoundary({
      plan: mutated,
      step: mutated.steps[0],
      stepIndex: 0,
      stepCount: 1,
      secret,
      challenge,
    }), false);
  }
});

test("CTA preview evidence rejects payloads that cannot be represented as strict canonical JSON", () => {
  const secret = randomBytes(32).toString("hex");
  const challenge = randomBytes(32).toString("base64url");
  const invalidValues = [undefined, Number.NaN, Number.POSITIVE_INFINITY, 1n, () => true];
  for (const invalid of invalidValues) {
    const plans = fixture();
    plans[0].steps[0].payload.unsafe = invalid;
    assert.throws(
      () => signCtaPreviewPlans(plans, { secret, challenge }),
      /canonical JSON payload/,
    );
  }
  const cyclic = fixture();
  cyclic[0].steps[0].payload.cyclic = cyclic[0].steps[0].payload;
  assert.throws(() => signCtaPreviewPlans(cyclic, { secret, challenge }), /canonical JSON payload/);

  const arrayCases = [
    (array) => { delete array[0]; },
    (array) => { array.extra = true; },
    (array) => { array[4294967295] = true; },
    (array) => { array[Symbol("hidden")] = true; },
    (array) => { array[0] = undefined; },
    (array) => { array[0] = () => true; },
    (array) => { array[0] = Number.NaN; },
    (array) => { array[0] = Number.POSITIVE_INFINITY; },
    (array) => { array[0] = 1n; },
    (array) => { array[0] = array; },
  ];
  for (const mutate of arrayCases) {
    const plans = fixture();
    const items = ["safe"];
    mutate(items);
    plans[0].steps[0].payload.items = items;
    assert.throws(() => signCtaPreviewPlans(plans, { secret, challenge }), /canonical JSON payload/);
  }
});

test("CTA preview evidence requires an explicit platform consistent with target identity", () => {
  const secret = randomBytes(32).toString("hex");
  const challenge = randomBytes(32).toString("base64url");
  const discordAsTelegram = fixture("discord");
  discordAsTelegram[0].target.platform = "telegram";
  assert.throws(() => signCtaPreviewPlans(discordAsTelegram, { secret, challenge }), /target platform/);

  const telegramAsDiscord = fixture("telegram");
  telegramAsDiscord[0].target.platform = "discord";
  assert.throws(() => signCtaPreviewPlans(telegramAsDiscord, { secret, challenge }), /target platform/);

  const missingPlatform = fixture();
  delete missingPlatform[0].target.platform;
  assert.throws(() => signCtaPreviewPlans(missingPlatform, { secret, challenge }), /target platform/);

  for (const platform of ["telegram", "discord"]) {
    const [signed] = signCtaPreviewPlans(fixture(platform), { secret, challenge });
    const mutated = structuredClone(signed);
    mutated.target.platform = platform === "telegram" ? "discord" : "telegram";
    assert.equal(verifyCtaPreviewBoundary({
      plan: mutated,
      step: mutated.steps[0],
      stepIndex: 0,
      stepCount: 1,
      secret,
      challenge,
    }), false);
  }
});

test("Telegram evidence binds payload routing to the target chat and normalized topic", () => {
  const secret = randomBytes(32).toString("hex");
  const challenge = randomBytes(32).toString("base64url");

  for (const mutate of [
    (plan) => { plan[0].steps[0].payload.chat_id = "-1002"; },
    (plan) => { plan[0].steps[0].payload.message_thread_id = 9; },
    (plan) => { delete plan[0].steps[0].payload.chat_id; },
    (plan) => { plan[0].target.topicId = 9; },
  ]) {
    const plans = fixture();
    mutate(plans);
    assert.throws(() => signCtaPreviewPlans(plans, { secret, challenge }), /Telegram payload destination/);
  }

  for (const emptyTopic of [undefined, null, 0, "0", ""]) {
    const plans = fixture();
    plans[0].target.threadId = null;
    if (emptyTopic === undefined) delete plans[0].steps[0].payload.message_thread_id;
    else plans[0].steps[0].payload.message_thread_id = emptyTopic;
    assert.doesNotThrow(() => signCtaPreviewPlans(plans, { secret, challenge }));
  }

  const [signed] = signCtaPreviewPlans(fixture(), { secret, challenge });
  signed.steps[0].payload.chat_id = "-1002";
  assert.equal(verifyCtaPreviewBoundary({
    plan: signed,
    step: signed.steps[0],
    stepIndex: 0,
    stepCount: 1,
    secret,
    challenge,
  }), false);
});
