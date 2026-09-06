import { NextResponse } from "next/server";
import { telegramMtprotoCall } from "../../../../lib/telegram-mtproto.mjs";
import { readJson } from "../../../../lib/json-store.js";
import { hydrateTelegramTopicAvailability, topicIdsByChatFromConfiguredGroups } from "../../../../lib/telegram-topic-availability.mjs";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Missing userId parameter" }, { status: 400 });
    }

    const [dialogs, configured] = await Promise.all([
      telegramMtprotoCall(null, "getDialogs", { limit: 100 }, { userId }),
      readJson("group-config.json", { groups: [] })
    ]);
    
    // Keep joined destinations visible so permission failures are explainable.
    // Sending still requires the independent live permission check.
    const accountDialogs = dialogs.filter(
      (dialog) => dialog.isGroup || dialog.isChannel
    );
    const groups = await hydrateTelegramTopicAvailability(
      accountDialogs,
      topicIdsByChatFromConfiguredGroups(configured.groups || []),
      { userId }
    );

    return NextResponse.json({ ok: true, groups });
  } catch (err) {
    console.error("Failed to fetch user dialogs:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
