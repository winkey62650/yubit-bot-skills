import { NextResponse } from "next/server";

import { cronSecretConfig } from "../../../../lib/deployment-config.mjs";
import { runSavedLarkMonitor } from "../../../../lib/lark-monitor.mjs";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

export async function GET(request) {
  if (!authorized(request)) return NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });
  try {
    return NextResponse.json({ ok: true, result: await runSavedLarkMonitor() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: String(error?.message || error) }, { status: 500 });
  }
}

function authorized(request) {
  const secret = cronSecretConfig(process.env).secret;
  return Boolean(secret && request.headers.get("authorization") === `Bearer ${secret}`);
}
