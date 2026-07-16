import { NextResponse } from "next/server";
import { cronSecretConfig } from "../../../../lib/deployment-config.mjs";
import { runDueDistributionJobs } from "../../../../lib/distribution-service.mjs";

export const maxDuration = 45;

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, deprecated: true, ...(await runDueDistributionJobs()) });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}

function authorized(request) {
  const secret = cronSecretConfig(process.env).secret;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}
