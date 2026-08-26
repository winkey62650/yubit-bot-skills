import { NextResponse } from "next/server";
import { telegramCall } from "../../../lib/automation-jobs.mjs";
import { getDistributionRepository } from "../../../lib/distribution-repository.mjs";
import {
  assertMarketIntelligenceDemoDelivery,
  marketIntelligenceDemoClaimKey,
  MARKET_INTELLIGENCE_DEMO_TARGET,
} from "../../../lib/market-intelligence-demo-delivery.mjs";
import { telegramDeliveryEnvironment } from "../../../lib/telegram-delivery-settings.mjs";
import { telegramUserPublisherHealth } from "../../../lib/telegram-user-session.mjs";

export const maxDuration = 60;

function publicError(error) {
  return String(error?.message || "Market Intelligence Demo delivery failed").slice(0, 500);
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  let repository;
  let claimKey;
  let claim;
  try {
    const validated = assertMarketIntelligenceDemoDelivery({
      plan: body.plan,
      previewChallenge: body.previewChallenge,
      acceptanceBatchId: body.acceptanceBatchId,
      env: process.env,
    });
    repository = await getDistributionRepository();
    const publisherEnv = await telegramDeliveryEnvironment("publish", process.env);
    const publisher = await telegramUserPublisherHealth({ repository, env: publisherEnv });
    if (publisher.mode !== "user" || publisher.required !== true || publisher.ready !== true
      || publisher.authorized !== true || publisher.username !== "@Serenity_Crypto") {
      throw new Error("The authorized @Serenity_Crypto production publisher is not ready");
    }

    claimKey = marketIntelligenceDemoClaimKey(validated.batchId);
    claim = {
      status: "sending",
      acceptanceBatchId: validated.batchId,
      chatId: MARKET_INTELLIGENCE_DEMO_TARGET.chatId,
      threadId: MARKET_INTELLIGENCE_DEMO_TARGET.threadId,
      startedAt: new Date().toISOString(),
    };
    const acquired = await repository.compareAndSetMeta(claimKey, { absent: true }, claim);
    if (!acquired) {
      return NextResponse.json({ ok: false, error: "This Demo acceptance batch has already been claimed" }, { status: 409 });
    }

    let sent;
    try {
      sent = await telegramCall(
        process.env.SPEAKER_BOT_TOKEN || process.env.TRADER1_BOT_TOKEN || "",
        "sendPhoto",
        validated.payload,
        fetch,
        { env: publisherEnv },
      );
    } catch (error) {
      await repository.setMeta(claimKey, {
        ...claim,
        status: "uncertain",
        failedAt: new Date().toISOString(),
        error: publicError(error),
      }).catch(() => {});
      throw error;
    }
    const messageId = Number(sent?.message_id);
    if (!Number.isSafeInteger(messageId) || messageId <= 0) {
      throw new Error("Telegram production publisher did not return a valid message ID");
    }
    const receipt = {
      ...claim,
      status: "delivered",
      messageId,
      deliveredAt: new Date().toISOString(),
    };
    let receiptPersisted = true;
    try {
      await repository.setMeta(claimKey, receipt);
    } catch {
      receiptPersisted = false;
    }
    return NextResponse.json({
      ok: true,
      delivery: {
        target: {
          chatId: MARKET_INTELLIGENCE_DEMO_TARGET.chatId,
          threadId: MARKET_INTELLIGENCE_DEMO_TARGET.threadId,
        },
        messageId,
        messageThreadId: MARKET_INTELLIGENCE_DEMO_TARGET.threadId,
        templateVersion: validated.plan.templateVersion,
      },
      publisherIdentity: {
        mode: publisher.mode,
        username: publisher.username,
        ready: publisher.ready,
        authorized: publisher.authorized,
      },
      receiptPersisted,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: publicError(error) }, { status: claim ? 502 : 400 });
  }
}
