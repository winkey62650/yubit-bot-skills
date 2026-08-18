import { NextResponse } from "next/server";
import { getDistributionRepository } from "../../../lib/distribution-repository.mjs";
import { loadDestinationCtaRegistry, saveDestinationCtaRegistry } from "../../../lib/destination-cta.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    const repository = await getDistributionRepository();
    return NextResponse.json({ ok: true, registry: await loadDestinationCtaRegistry(repository) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

export async function POST(request) {
  try {
    const body = await request.json();
    const repository = await getDistributionRepository();
    const registry = await saveDestinationCtaRegistry(repository, body.configs);
    return NextResponse.json({ ok: true, registry });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 400 });
  }
}
