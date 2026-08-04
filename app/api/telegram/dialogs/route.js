import { NextResponse } from "next/server";
import { telegramMtprotoCall } from "../../../../lib/telegram-mtproto.mjs";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const userId = searchParams.get("userId");
    if (!userId) {
      return NextResponse.json({ ok: false, error: "Missing userId parameter" }, { status: 400 });
    }

    const dialogs = await telegramMtprotoCall(null, "getDialogs", { limit: 100 }, { userId });
    
    // Filter out simple users (DMs), keeping only groups/channels
    const groups = dialogs.filter(d => d.isGroup || d.isChannel);

    return NextResponse.json({ ok: true, groups });
  } catch (err) {
    console.error("Failed to fetch user dialogs:", err);
    return NextResponse.json({ ok: false, error: err.message }, { status: 500 });
  }
}
