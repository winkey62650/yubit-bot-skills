import { NextResponse } from "next/server";
import { discoverCurrentBotGroups } from "../../../lib/telegram-group-service.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const discovery = await discoverCurrentBotGroups();
    return NextResponse.json(discovery, { headers: { "cache-control": "no-store, max-age=0" } });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message, bots: [], groups: [] }, { status: 502 });
  }
}
