import process from "node:process";

const apiBase = "https://api.telegram.org/bot";
const token = process.env.TELEGRAM_BOT_TOKEN;
const targetIds = parseIds(process.env.TARGET_IDS || process.env.TELEGRAM_CHAT_ID || "");
const threadId = process.env.TELEGRAM_THREAD_ID ? Number(process.env.TELEGRAM_THREAD_ID) : undefined;
const message = process.env.BULK_MESSAGE || "YUBIT official update.";
const dryRun = process.env.DRY_RUN !== "false";

console.log(
  JSON.stringify(
    {
      action: "bulk-send",
      dryRun,
      targets: targetIds,
      threadId: threadId || null,
      preview: message
    },
    null,
    2
  )
);

if (!targetIds.length) {
  throw new Error("No target ids. Set TARGET_IDS or TELEGRAM_CHAT_ID.");
}

if (dryRun) {
  console.log("Dry Run: message preview generated only.");
  process.exit(0);
}

if (!token) {
  throw new Error("TELEGRAM_BOT_TOKEN is required in Production.");
}

const results = [];

for (const chatId of targetIds) {
  const payload = {
    chat_id: chatId,
    text: message,
    parse_mode: "HTML",
    disable_web_page_preview: true
  };
  if (threadId) payload.message_thread_id = threadId;

  const response = await fetch(`${apiBase}${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const body = await response.json();
  results.push({ chatId, ok: body.ok, message_id: body.result?.message_id, error: body.description });
  await sleep(1200);
}

console.log(JSON.stringify({ ok: results.every((item) => item.ok), results }, null, 2));

function parseIds(value = "") {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
