import { after, NextResponse } from "next/server";
import {
  processTelegramWebhookUpdate,
  verifyTelegramWebhookSecret
} from "../../../../lib/distribution-service.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(request) {
  const secret = request.headers.get("x-telegram-bot-api-secret-token");
  if (!verifyTelegramWebhookSecret(secret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  const update = await request.json().catch(() => null);
  if (!update || typeof update !== "object") {
    return NextResponse.json({ ok: false, error: "Invalid Telegram update" }, { status: 400 });
  }
  try {
    const result = await processTelegramWebhookUpdate(update, { defer: after });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    console.error("Telegram webhook failed", { updateId: update.update_id, message: error.message });
    return NextResponse.json({ ok: false, error: "Webhook processing failed" }, { status: 500 });
  }
}
