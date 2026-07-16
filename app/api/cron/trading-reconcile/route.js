import { runTradingReconciliation } from "../../../../lib/trading-service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorized(request) {
  const secret = String(process.env.CRON_SECRET || "");
  return Boolean(secret) && request.headers.get("authorization") === `Bearer ${secret}`;
}

export async function GET(request) {
  if (!authorized(request)) return Response.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    const result = await runTradingReconciliation();
    return Response.json({ ok: true, ...result });
  } catch {
    return Response.json({ ok: false, error: "Trading reconciliation failed" }, { status: 500 });
  }
}
