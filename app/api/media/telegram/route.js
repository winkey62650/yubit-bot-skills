import { createHmac, timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function validSignature(fileId, actual, secret) {
  if (!fileId || !actual || !secret) return false;
  const expected = createHmac("sha256", secret).update(fileId).digest("hex");
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export async function GET(request) {
  const url = new URL(request.url);
  const fileId = url.searchParams.get("fileId") || "";
  const signature = url.searchParams.get("sig") || "";
  const secret = String(process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();
  const botToken = String(process.env.FORWARD_BOT_TOKEN || "").trim();
  if (!validSignature(fileId, signature, secret)) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!botToken) {
    return NextResponse.json({ ok: false, error: "ForwardBot is not configured" }, { status: 503 });
  }
  const metadataResponse = await fetch(`https://api.telegram.org/bot${botToken}/getFile?file_id=${encodeURIComponent(fileId)}`, { cache: "no-store" });
  const metadata = await metadataResponse.json().catch(() => ({}));
  if (!metadataResponse.ok || !metadata.ok || !metadata.result?.file_path) {
    return NextResponse.json({ ok: false, error: metadata.description || "Telegram file lookup failed" }, { status: 502 });
  }
  const fileResponse = await fetch(`https://api.telegram.org/file/bot${botToken}/${metadata.result.file_path}`, { cache: "no-store" });
  if (!fileResponse.ok || !fileResponse.body) {
    return NextResponse.json({ ok: false, error: "Telegram file download failed" }, { status: 502 });
  }
  return new Response(fileResponse.body, {
    status: 200,
    headers: {
      "content-type": fileResponse.headers.get("content-type") || "application/octet-stream",
      "cache-control": "private, max-age=300"
    }
  });
}
