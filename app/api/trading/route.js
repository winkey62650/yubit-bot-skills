import { NextResponse } from "next/server";

import {
  configureSpeakerWebhook,
  diagnoseExchangeOrder,
  getTradingManagementOverview,
  recoverTraderOrder,
  sanitizeTradingResponse,
  saveExchangeAccount,
  saveTrader,
  saveTradingDestination,
  testTradingDestination,
  tradingErrorStatus,
  verifyExchangeAccount,
  verifyTradingDestination,
} from "../../../lib/trading-service.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 30;

function failure(error) {
  const status = tradingErrorStatus(error);
  return NextResponse.json({
    ok: false,
    error: sanitizeTradingResponse(error?.message || "操作失败"),
  }, { status: Math.min(599, Math.max(400, status)) });
}

export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...(await getTradingManagementOverview()) });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    if (body.action === "save-trader") {
      return NextResponse.json({ ok: true, message: "Trader 保存成功", trader: await saveTrader(body.trader ?? body) });
    }
    if (body.action === "save-account") {
      return NextResponse.json({ ok: true, message: "YUBIT 账户保存成功", result: await saveExchangeAccount(body.account ?? body) });
    }
    if (body.action === "verify-account") {
      return NextResponse.json({ ok: true, message: "YUBIT 查询权限验证成功", result: await verifyExchangeAccount(body) });
    }
    if (body.action === "diagnose-order") {
      return NextResponse.json({ ok: true, message: "订单只读诊断完成", result: await diagnoseExchangeOrder(body) });
    }
    if (body.action === "recover-order") {
      return NextResponse.json({ ok: true, message: "订单恢复处理完成", result: await recoverTraderOrder(body) });
    }
    if (body.action === "save-destination") {
      return NextResponse.json({ ok: true, message: "发送目标保存成功", destination: await saveTradingDestination(body.destination ?? body) });
    }
    if (body.action === "verify-destination") {
      return NextResponse.json({ ok: true, message: "发送目标验证完成", result: await verifyTradingDestination(body.destinationId ?? body.id) });
    }
    if (body.action === "test-destination") {
      return NextResponse.json({ ok: true, message: "测试消息发送成功", result: await testTradingDestination(body.destinationId ?? body.id) });
    }
    if (body.action === "configure-webhook") {
      return NextResponse.json({ ok: true, message: "SpeakerBot Webhook 配置成功", result: await configureSpeakerWebhook() });
    }
    return NextResponse.json({ ok: false, error: "不支持的操作" }, { status: 400 });
  } catch (error) {
    return failure(error);
  }
}
