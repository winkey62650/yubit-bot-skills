import { NextResponse } from "next/server";
import { retryDistributionDelivery } from "../../../../lib/distribution-service.mjs";
import { getDistributionRepository } from "../../../../lib/distribution-repository.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request) {
  try {
    const params = new URL(request.url).searchParams;
    const repository = await getDistributionRepository();
    const items = await repository.listDeliveries({ status: params.get("status") || "", limit: Math.min(Number(params.get("limit") || 200), 500) });
    return NextResponse.json({ ok: true, items });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 503 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const id = body.id || body.deliveryId;
    if (body.action !== "retry" || !id) return NextResponse.json({ ok: false, error: "无效操作" }, { status: 400 });
    const result = await retryDistributionDelivery(id);
    return NextResponse.json({ ok: result.status === "success", result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
