import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

const tokenPath = join(process.cwd(), ".env.telegram-tokens.local");
const fields = ["YUBITADMIN_BOT_TOKEN", "TRADER1_BOT_TOKEN", "FORWARD_BOT_TOKEN"];

export async function GET() {
  const tokens = await readTokens();
  return NextResponse.json({
    configured: Object.fromEntries(fields.map((field) => [field, Boolean(tokens[field])]))
  });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const updates = Object.fromEntries(fields.map((field) => [field, String(body[field] || "").trim()]).filter(([, value]) => value));
  if (!Object.keys(updates).length) {
    return NextResponse.json({ ok: false, error: "请至少填写一个 Token。" }, { status: 400 });
  }

  const tokens = { ...(await readTokens()), ...updates };
  await writeFile(tokenPath, `${Object.entries(tokens).map(([key, value]) => `${key}=${value}`).join("\n")}\n`, { mode: 0o600 });
  return NextResponse.json({ ok: true, configured: Object.fromEntries(fields.map((field) => [field, Boolean(tokens[field])])) });
}

async function readTokens() {
  if (!existsSync(tokenPath)) return {};
  return parseEnv(await readFile(tokenPath, "utf8"));
}

function parseEnv(text) {
  return Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const index = line.indexOf("=");
        return [line.slice(0, index), line.slice(index + 1)];
      })
  );
}
