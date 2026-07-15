import { NextResponse } from "next/server";
import { createDistributionEngine } from "../../../../lib/distribution-service.mjs";
import { getDistributionRepository } from "../../../../lib/distribution-repository.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(request) {
  try {
    const status = new URL(request.url).searchParams.get("status") || "pending";
    const repository = await getDistributionRepository();
    return NextResponse.json({ ok: true, items: await repository.listReviewQueue({ status, limit: 200 }) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 503 });
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const engine = await createDistributionEngine();
    const ids = [...new Set([...(Array.isArray(body.ids) ? body.ids : []), ...(body.id ? [body.id] : [])])].slice(0, 100);
    if (!ids.length) return NextResponse.json({ ok: false, error: "请选择待审核内容" }, { status: 400 });
    const results = [];
    for (const id of ids) {
      try {
        results.push({ id, ok: true, event: body.action === "reject" ? await engine.reject(id) : await engine.approve(id) });
      } catch (error) {
        results.push({ id, ok: false, error: error.message });
      }
    }
    return NextResponse.json({ ok: results.every((item) => item.ok), results });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
