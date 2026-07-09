import { existsSync, readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { getTelegramGroupMetrics } from "../../../lib/telegram-metrics.mjs";

export async function GET() {
  const tokens = readTokenEnv(".env.telegram-tokens.local");
  const token = tokens.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  const result = await getTelegramGroupMetrics(token);
  return NextResponse.json(result, { status: result.ok ? 200 : 500 });
}

function readTokenEnv(path) {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
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
