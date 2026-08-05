import { NextResponse } from "next/server";
import { getDistributionRepository } from "../../../../lib/distribution-repository.mjs";
import { createTelegramUserSessionStore } from "../../../../lib/telegram-user-session.mjs";

export async function DELETE(request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get("userId");

    if (!userId) {
      return NextResponse.json({ ok: false, error: "userId is required" }, { status: 400 });
    }

    const repository = await getDistributionRepository();
    const store = createTelegramUserSessionStore({
      repository,
      encryptionKey: process.env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY
    });

    await store.clear(userId);

    return NextResponse.json({ ok: true });
  } catch (error) {
    console.error("[delete session error]", error);
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
