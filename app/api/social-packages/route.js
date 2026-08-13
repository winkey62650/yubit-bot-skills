import { NextResponse } from "next/server";
import { readJson, writeJson } from "../../../lib/json-store";
import { previewSocialSource } from "../../../lib/automation-jobs.mjs";
import {
  normalizeSocialPackages,
  validateChangedSocialPackageRoutes,
  validateSocialPackageRoutes
} from "../../../lib/social-sources.mjs";

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
  if (body.action) {
    return NextResponse.json({ ok: false, error: `不支持的操作：${String(body.action)}` }, { status: 400 });
  }
  const packages = normalizeSocialPackages(body.packages || body);
  const currentConfig = await readJson(socialPackagesPath, { packages: [] });
  const routeValidation = validateChangedSocialPackageRoutes(
    currentConfig.packages || currentConfig,
    packages
  );
  if (!routeValidation.ok) {
    return NextResponse.json({
      ok: false,
      error: `以下已启用来源尚未绑定发布群和 Topic：${routeValidation.unmapped.map((item) => item.name).join("、")}`,
      unmapped: routeValidation.unmapped
    }, { status: 422 });
  }
  const config = { packages, updatedAt: new Date().toISOString() };
  await writeJson(socialPackagesPath, config);
  return NextResponse.json({
    ok: true,
    ...config,
    warnings: validateSocialPackageRoutes(packages).unmapped
  });
}
