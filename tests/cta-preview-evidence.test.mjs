import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";

const require = createRequire(import.meta.url);
const {
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
      payload: { [field]: payload },
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
  const secret = randomBytes(32).toString("base64url");
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
  assert.throws(() => signCtaPreviewPlans(fixture(), { secret: "short", challenge: randomBytes(32).toString("base64url") }), /CTA_PREVIEW_EVIDENCE_SECRET/);
  assert.throws(() => signCtaPreviewPlans(fixture(), { secret: randomBytes(32).toString("base64url"), challenge: "predictable" }), /preview challenge/);
});
