import { NextResponse } from "next/server";

import { buildReleaseInfo } from "../../../lib/release-info.mjs";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json(buildReleaseInfo(process.env));
}
