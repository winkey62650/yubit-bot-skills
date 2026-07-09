import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

const socialPackagesPath = join(process.cwd(), ".runtime", "social-packages.json");

export async function GET() {
  if (!existsSync(socialPackagesPath)) {
    return NextResponse.json({ ok: true, packages: defaultSocialPackages(), updatedAt: null });
  }
  const config = JSON.parse(await readFile(socialPackagesPath, "utf8"));
  return NextResponse.json({
    ok: true,
    packages: normalizeSocialPackages(config.packages || config),
    updatedAt: config.updatedAt || null
  });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const packages = normalizeSocialPackages(body.packages || body);
  if (!packages.length) {
    return NextResponse.json({ ok: false, error: "Missing social packages" }, { status: 400 });
  }
  const config = { packages, updatedAt: new Date().toISOString() };
  await mkdir(join(process.cwd(), ".runtime"), { recursive: true });
  await writeFile(socialPackagesPath, JSON.stringify(config, null, 2));
  return NextResponse.json({ ok: true, ...config });
}

function defaultSocialPackages() {
  return [
    { name: "Ricky 社媒转发包", agent: "Ricky", platform: "Twitter / X + YouTube", accountUrl: "https://x.com/Ricky / Ricky Channel", contentType: "全部新内容", frequency: "每 5 分钟", bot: "YUBITadmin", status: "已启用" },
    { name: "Jack 社媒转发包", agent: "Jack", platform: "Twitter / X", accountUrl: "待录入", contentType: "全部新内容", frequency: "每 5 分钟", bot: "YUBITadmin", status: "待接入" },
    { name: "Tony 社媒转发包", agent: "Tony", platform: "YouTube", accountUrl: "待录入", contentType: "全部新内容", frequency: "每 5 分钟", bot: "YUBITadmin", status: "待接入" }
  ];
}

function normalizeSocialPackages(packages) {
  return (Array.isArray(packages) ? packages : [])
    .map((item, index) => ({
      id: String(item?.id || `social-${normalizeName(item?.agent || item?.name || index + 1)}`),
      name: String(item?.name || `社媒转发包 ${index + 1}`).trim(),
      agent: String(item?.agent || "").trim(),
      platform: String(item?.platform || "Twitter / X").trim(),
      accountUrl: String(item?.accountUrl || item?.url || "").trim(),
      contentType: String(item?.contentType || "全部新内容").trim(),
      frequency: String(item?.frequency || "每 5 分钟").trim(),
      bot: String(item?.bot || "YUBITadmin").trim(),
      status: String(item?.status || "已启用").trim()
    }))
    .filter((item) => item.name && item.agent);
}

function normalizeName(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "item";
}
