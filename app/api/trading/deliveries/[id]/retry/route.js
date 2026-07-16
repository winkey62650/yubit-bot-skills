import { NextResponse } from "next/server";

import { retryTradingDelivery, sanitizeTradingResponse, tradingErrorStatus } from "../../../../../../lib/trading-service.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

export async function POST(_request, context) {
  try {
    const { id } = await context.params;
    return NextResponse.json({ ok: true, message: "投递重试完成", ...(await retryTradingDelivery(id)) });
  } catch (error) {
    const status = tradingErrorStatus(error);
    return NextResponse.json({ ok: false, error: sanitizeTradingResponse(error?.message || "重试失败") }, { status });
  }
}
