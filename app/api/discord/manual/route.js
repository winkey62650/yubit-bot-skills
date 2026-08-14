import { NextResponse } from "next/server";

import { checkDiscordHealth, getDiscordStatus, sendDiscordManualPublish } from "../../../../lib/discord-service.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(payload, status = 200) {
  return NextResponse.json(payload, { status, headers: { "Cache-Control": "no-store" } });
}

export async function GET() {
  const [statusResult, healthResult] = await Promise.allSettled([getDiscordStatus(), checkDiscordHealth()]);
  if (statusResult.status === "rejected" && healthResult.status === "rejected") {
    return json({ ok: false, error: statusResult.reason?.message || healthResult.reason?.message || "Discord 状态读取失败。" }, 500);
  }

  return json({
    ok: true,
    status: statusResult.status === "fulfilled" ? statusResult.value : { guilds: [], config: { guilds: {} } },
    health: healthResult.status === "fulfilled" ? healthResult.value : { checkedAt: null, summary: {}, guilds: [] },
  });
}

export async function POST(request) {
  try {
    const body = await request.json();
    const manualPublish = await sendDiscordManualPublish({
      channelIds: body.channelIds,
      content: body.content,
      imageUrl: body.imageUrl,
    });
    return json({ ok: true, result: { manualPublish } });
  } catch (error) {
    return json({ ok: false, error: error.message || "Discord 手动发布失败。" }, 400);
  }
}
