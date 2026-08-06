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
    
    // Only expose destinations the selected account can actually publish to.
    const writableDialogs = dialogs.filter(
      (dialog) => (dialog.isGroup || dialog.isChannel) && dialog.canSendMessages === true
    );
    const groups = await hydrateTelegramTopicAvailability(
      writableDialogs,
      topicIdsByChatFromConfiguredGroups(configured.groups || []),
      { userId }
    );

    return NextResponse.json({ ok: true, groups });
  } catch (err) {
    console.error("Failed to fetch user dialogs:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
