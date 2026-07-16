import { after, NextResponse } from "next/server";

import {
  getSpeakerWebhookSecret,
  processSpeakerTelegramUpdate,
  sanitizeTradingResponse,
  verifySpeakerWebhookSecret,
} from "../../../../lib/trading-service.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request) {
  const actualSecret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!verifySpeakerWebhookSecret(actualSecret, getSpeakerWebhookSecret(process.env))) {
    return NextResponse.json({ ok: false, error: "Webhook verification failed" }, { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid Telegram update" }, { status: 400 });
  }
  if (!update || typeof update !== "object" || Array.isArray(update)) {
    return NextResponse.json({ ok: false, error: "Invalid Telegram update" }, { status: 400 });
  }

  try {
    const result = await processSpeakerTelegramUpdate(update, { defer: after });
    return NextResponse.json({ ok: true, result: sanitizeTradingResponse(result) });
  } catch (error) {
    console.error("SpeakerBot webhook processing failed", {
      updateId: update?.update_id ?? null,
      errorCode: String(error?.message || "SPEAKER_WEBHOOK_FAILED").slice(0, 80),
    });
    return NextResponse.json({ ok: false, error: "Telegram update processing failed" }, { status: 500 });
  }
}
