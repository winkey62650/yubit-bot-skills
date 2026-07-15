import { NextResponse } from "next/server";
import { discoverCurrentBotGroups, probeGroupByChatId } from "../../../lib/telegram-group-service.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const discovery = await discoverCurrentBotGroups();
    return NextResponse.json({
      ...discovery,
      chats: discovery.groups
    }, { headers: { "cache-control": "no-store, max-age=0" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message, chats: [], groups: [], bots: [] }, { status: 502 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const discovery = await probeGroupByChatId(body.chatId);
    return NextResponse.json({
      ...discovery,
      chats: discovery.groups
    }, { headers: { "cache-control": "no-store, max-age=0" } });
  } catch (error) {
    const isInputError = /以 -100 开头/.test(error.message);
    return NextResponse.json({
      ok: false,
      error: error.message,
      chats: [],
      groups: [],
      bots: []
    }, { status: isInputError ? 400 : 502 });
  }
}
