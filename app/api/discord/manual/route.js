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
    const contentType = String(request.headers.get("content-type") || "");
    let body;
    if (contentType.includes("multipart/form-data")) {
      const formData = await request.formData();
      const image = formData.get("image");
      let attachment = null;
      if (image && typeof image.arrayBuffer === "function" && Number(image.size || 0) > 0) {
        if (!String(image.type || "").startsWith("image/")) throw new Error("只允许上传图片文件。");
        if (Number(image.size) > 10 * 1024 * 1024) throw new Error("图片大小不能超过 10MB。");
        attachment = {
          data: Buffer.from(await image.arrayBuffer()),
          filename: String(image.name || "discord-image.png").replace(/[^\w. -]/g, "_").slice(0, 120),
          contentType: String(image.type || "application/octet-stream"),
        };
      }
      body = {
        channelIds: formData.getAll("channelIds").map(String),
        content: String(formData.get("content") || ""),
        imageUrl: String(formData.get("imageUrl") || ""),
        attachment,
      };
    } else {
      body = await request.json();
    }
    const manualPublish = await sendDiscordManualPublish({
      channelIds: body.channelIds,
      content: body.content,
      imageUrl: body.imageUrl,
      attachment: body.attachment,
    });
    return json({ ok: true, result: { manualPublish } });
  } catch (error) {
    return json({ ok: false, error: error.message || "Discord 手动发布失败。" }, 400);
  }
}
