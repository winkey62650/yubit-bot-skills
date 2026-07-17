import { NextResponse } from "next/server";
import { deleteDistributionRules } from "../../../lib/distribution-bulk-delete.mjs";
import { getDistributionRepository } from "../../../lib/distribution-repository.mjs";
import {
  distributionOverview,
  configureForwardWebhook,
  ensureLegacyDistributionMigration,
  runDistributionAutomationRule,
  saveDistributionRule,
  sendRuleTest,
  validateRuleRuntime
} from "../../../lib/distribution-service.mjs";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ ok: true, ...(await distributionOverview()) });
  } catch (error) {
    return failure(error, 503);
  }
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  try {
    const repository = await getDistributionRepository();
    if (body.action === "delete-many") {
      return NextResponse.json(await deleteDistributionRules(repository, body.ids));
    }
    if (body.action === "delete") return NextResponse.json({ ok: await repository.deleteRule(String(body.id || "")) });
    if (body.action === "toggle") {
      const rule = await repository.getRule(String(body.id || ""));
      if (!rule) return NextResponse.json({ ok: false, error: "规则不存在" }, { status: 404 });
      return NextResponse.json({ ok: true, rule: await repository.saveRule({ ...rule, enabled: Boolean(body.enabled) }) });
    }
    if (body.action === "validate") return NextResponse.json({ ok: true, result: await validateRuleRuntime(String(body.id || "")) });
    if (body.action === "test") return NextResponse.json({ ok: true, result: await sendRuleTest(String(body.id || "")) });
    if (body.action === "run-now") return NextResponse.json({ ok: true, result: await runDistributionAutomationRule(String(body.id || "")) });
    if (body.action === "migrate") return NextResponse.json({ ok: true, migration: await ensureLegacyDistributionMigration(repository) });
    if (body.action === "configure-webhook") return NextResponse.json({ ok: true, webhook: await configureForwardWebhook() });
    return NextResponse.json({ ok: true, rule: await saveDistributionRule(body.rule ?? body) });
  } catch (error) {
    return failure(error, error.statusCode || 500);
  }
}

function failure(error, status) {
  return NextResponse.json({ ok: false, error: error?.message || "操作失败", details: error?.details }, { status });
}
