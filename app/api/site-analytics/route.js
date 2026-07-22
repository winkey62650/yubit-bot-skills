import { NextResponse } from "next/server";
import { fetchSiteAnalytics } from "../../../lib/site-analytics.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request) {
  const url = new URL(request.url);
  try {
    const data = await fetchSiteAnalytics({
      range: url.searchParams.get("range"),
      site: url.searchParams.get("site")
    }, { signal: AbortSignal.timeout(8_000) });
    return NextResponse.json({ ok: true, data });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error?.name === "TimeoutError" ? "站点数据服务响应超时" : error?.message || "站点数据读取失败"
    }, { status: Number(error?.statusCode) >= 400 ? Number(error.statusCode) : 503 });
  }
}
