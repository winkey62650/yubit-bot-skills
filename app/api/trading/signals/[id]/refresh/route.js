import { NextResponse } from "next/server";

import { refreshTradingSignal, sanitizeTradingResponse, tradingErrorStatus } from "../../../../../../lib/trading-service.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(_request, context) {
  try {
    const { id } = await context.params;
    return NextResponse.json({ ok: true, message: "交易记录刷新完成", ...(await refreshTradingSignal(id)) });
  } catch (error) {
    const status = tradingErrorStatus(error);
    return NextResponse.json({ ok: false, error: sanitizeTradingResponse(error?.message || "刷新失败") }, { status });
  }
}
