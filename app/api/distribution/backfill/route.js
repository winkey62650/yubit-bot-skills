import { NextResponse } from "next/server";
import { backfillRule } from "../../../../lib/distribution-service.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const result = await backfillRule(String(body.ruleId || ""), body.references, { preview: body.preview !== false });
    return NextResponse.json({ ok: true, result });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
}
