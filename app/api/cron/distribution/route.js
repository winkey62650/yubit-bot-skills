import { NextResponse } from "next/server";
import { cronSecretConfig } from "../../../../lib/deployment-config.mjs";
import { runDueDistributionJobs } from "../../../../lib/distribution-service.mjs";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request) {
  const secret = cronSecretConfig(process.env).secret;
  if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) {
    return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  }
  try {
    return NextResponse.json({ ok: true, ...(await runDueDistributionJobs()) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
