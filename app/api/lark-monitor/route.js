import { NextResponse } from "next/server";

import { readLarkMonitorStatus, runSavedLarkMonitor } from "../../../lib/lark-monitor.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET() {
  try {
    return NextResponse.json({ ok: true, status: await readLarkMonitorStatus() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (body.action !== "test") {
    return NextResponse.json({ ok: false, error: "不支持的操作" }, { status: 400 });
  }
  try {
    const result = await runSavedLarkMonitor({ force: true });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 502 });
  }
}
