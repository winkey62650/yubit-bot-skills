import { NextResponse } from "next/server";
import { readJson, updateJson } from "../../../lib/json-store";
import { previewSocialSource } from "../../../lib/automation-jobs.mjs";
import {
  applySocialPackageMutation,
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
  const mutationActions = new Set(["upsert", "set-status", "delete"]);
  if (body.action && !mutationActions.has(body.action)) {
    return NextResponse.json({ ok: false, error: `不支持的操作：${String(body.action)}` }, { status: 400 });
  }
  try {
    const config = await updateJson(socialPackagesPath, (currentConfig) => {
      const currentPackages = normalizeSocialPackages(currentConfig.packages || currentConfig);
      const packages = body.action
        ? applySocialPackageMutation(currentPackages, body)
        : normalizeSocialPackages(body.packages || body);
      const routeValidation = validateChangedSocialPackageRoutes(currentPackages, packages);
      if (!routeValidation.ok) {
        const error = new Error(`以下已启用来源尚未绑定发布群和 Topic：${routeValidation.unmapped.map((item) => item.name).join("、")}`);
        error.statusCode = 422;
        error.unmapped = routeValidation.unmapped;
        throw error;
      }
      return { packages, updatedAt: new Date().toISOString() };
    }, { packages: [], updatedAt: null });
    const packages = normalizeSocialPackages(config.packages || config);
    return NextResponse.json({
      ok: true,
      packages,
      updatedAt: config.updatedAt || null,
      warnings: validateSocialPackageRoutes(packages).unmapped
    });
  } catch (error) {
    return NextResponse.json({
      ok: false,
      error: error.message || "代理来源保存失败",
      ...(error.unmapped ? { unmapped: error.unmapped } : {})
    }, { status: error.statusCode || 409 });
  }
}
