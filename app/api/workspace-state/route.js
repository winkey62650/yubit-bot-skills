import { NextResponse } from "next/server";
import { readJson, writeJson } from "../../../lib/json-store";
import { isSupportedWorkspaceSection, normalizeWorkspaceState } from "../../../lib/workspace-state.mjs";

export const dynamic = "force-dynamic";

export async function GET(request) {
  const section = new URL(request.url).searchParams.get("section") || "";
  if (!isSupportedWorkspaceSection(section)) {
    return NextResponse.json({ ok: false, error: "不支持的配置区域" }, { status: 400 });
  }
  const saved = await readJson(pathname(section), null);
  return NextResponse.json({ ok: true, section, state: saved?.state || null, updatedAt: saved?.updatedAt || null });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const section = String(body.section || "");
  if (!isSupportedWorkspaceSection(section)) {
    return NextResponse.json({ ok: false, error: "不支持的配置区域" }, { status: 400 });
  }
  const state = normalizeWorkspaceState(section, body.state || {});
  const saved = { schemaVersion: 1, section, state, updatedAt: new Date().toISOString() };
  await writeJson(pathname(section), saved);
  return NextResponse.json({ ok: true, ...saved });
}

function pathname(section) {
  return `workspace-state/${section}.json`;
}
