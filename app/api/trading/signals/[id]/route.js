import { NextResponse } from "next/server";

import { getTradingSignalDetail, sanitizeTradingResponse, tradingErrorStatus } from "../../../../../lib/trading-service.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(_request, context) {
  try {
    const { id } = await context.params;
    return NextResponse.json({ ok: true, ...(await getTradingSignalDetail(id)) });
  } catch (error) {
    const status = tradingErrorStatus(error);
    return NextResponse.json({ ok: false, error: sanitizeTradingResponse(error?.message || "读取失败") }, { status });
  }
}
