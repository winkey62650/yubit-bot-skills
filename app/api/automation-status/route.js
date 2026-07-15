import { NextResponse } from "next/server";
import { getAutomationStatus } from "../../../lib/automation-jobs.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, jobs: await getAutomationStatus(), serverTime: new Date().toISOString() });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error.message }, { status: 500 });
  }
}
