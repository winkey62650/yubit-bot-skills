import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NextResponse } from "next/server";

const configPath = join(process.cwd(), ".runtime", "market-event-ai.json");

export async function GET() {
  if (!existsSync(configPath)) return NextResponse.json({ ok: true, config: defaultConfig(), updatedAt: null });
  const saved = JSON.parse(await readFile(configPath, "utf8"));
  return NextResponse.json({ ok: true, config: { ...defaultConfig(), ...saved.config }, updatedAt: saved.updatedAt || null });
}

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const config = { ...defaultConfig(), ...(body?.config || body) };
  if (!String(config.prompt || "").trim()) return NextResponse.json({ ok: false, error: "AI prompt cannot be empty" }, { status: 400 });
  const saved = { config, updatedAt: new Date().toISOString() };
  await mkdir(join(process.cwd(), ".runtime"), { recursive: true });
  await writeFile(configPath, JSON.stringify(saved, null, 2));
  return NextResponse.json({ ok: true, ...saved });
}

function defaultConfig() {
  return {
    chatId: "-1004331355892",
    threadId: "169",
    imagePath: "assets/market-events/market-event-cover.jpg",
    prompt: `You are the YUBIT Market Events editor. Convert supplied market news into a concise, factual Telegram post.\n\nReturn valid JSON only:\n{\n  "title": "Market Highlights (Mon D)",\n  "highlights": [\n    { "heading": "Short headline", "detail": "One concise sentence with only material facts and figures." }\n  ]\n}\n\nRules:\n- Write in clear English.\n- Select exactly 3 most material highlights.\n- Keep each heading to 4–9 words and each detail to 1–2 short sentences.\n- Preserve supplied dates, tickers, percentages, and dollar amounts exactly.\n- Do not add facts, forecasts, trade calls, hype, or investment advice.\n- Keep the complete Telegram caption below 900 characters.\n- Do not add Markdown, explanations, or any text outside the JSON.`
  };
}
