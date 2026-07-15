import { NextResponse } from "next/server";
import { readJson, writeJson } from "../../../lib/json-store";
import { previewSocialSource } from "../../../lib/automation-jobs.mjs";
import { normalizeSocialPackages } from "../../../lib/social-sources.mjs";

const socialPackagesPath = "social-packages.json";
export const dynamic = "force-dynamic";

export async function GET() {
  const config = await readJson(socialPackagesPath, { packages: [], updatedAt: null });
  return NextResponse.json({
    ok: true,
    packages: normalizeSocialPackages(config.packages || config),
    updatedAt: config.updatedAt || null
  });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (body.action === "test") {
    try {
      return NextResponse.json({ ok: true, preview: await previewSocialSource(body.source || {}) });
    } catch (error) {
      return NextResponse.json({ ok: false, error: error.message }, { status: 422 });
    }
  }
  const packages = normalizeSocialPackages(body.packages || body);
  const config = { packages, updatedAt: new Date().toISOString() };
  await writeJson(socialPackagesPath, config);
  return NextResponse.json({ ok: true, ...config });
}
