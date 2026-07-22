import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { NextResponse } from "next/server";
import { buildSelectedTopicTemplateJson } from "../../../lib/new-group-topics.mjs";
import { defaultTopicTemplate } from "../../../templates.mjs";

export const maxDuration = 300;

const scriptMap = {
  batchManage: {
    label: "Batch Manage",
    command: ["scripts/batch-manage.mjs"]
  },
  bulkSend: {
    label: "Bulk Send",
    command: ["scripts/bulk-send.mjs"]
  },
  newGroup: {
    label: "New Group Setup",
    command: ["scripts/new-group-setup.mjs"]
  },
  cleanupTopics: {
    label: "Cleanup Duplicate Topics",
    command: ["scripts/close-duplicate-topics.mjs"]
  },
  repairTopicNames: {
    label: "Repair Topic Names",
    command: ["scripts/repair-topic-names.mjs"]
  },
  tokens: {
    label: "Token Settings",
    command: ["scripts/token-settings.mjs"]
  },
  cardSender: {
    label: "Card Sender",
    command: ["scripts/card-sender.mjs"]
  },
  futuresCard: {
    label: "Futures Card",
    command: ["binance-futures-sma-signal.mjs"]
  },
  tradfiCard: {
    label: "TradFi Card",
    command: ["tradfi-market-signal.mjs"]
  },
  newsCard: {
    label: "News Card",
    command: ["news-poster.mjs"]
  },
  cycle15m: {
    label: "15m Cycle",
    command: ["run-15m-cycle.mjs"]
  }
};

export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  const script = scriptMap[body.scriptId];

  if (!script) {
    return NextResponse.json({ ok: false, error: "Unknown scriptId" }, { status: 400 });
  }

  const payload = body.payload || {};
  let env;
  try {
    env = buildEnv(payload, body.scriptId);
  } catch (error) {
    return NextResponse.json({ ok: false, label: script.label, error: error.message }, { status: 400 });
  }

  try {
    const result = await runNode(script.command, env);
    return NextResponse.json({
      ok: true,
      label: script.label,
      code: result.code,
      stdout: result.stdout,
      stderr: result.stderr
    });
  } catch (error) {
    return NextResponse.json(
      {
        ok: false,
        label: script.label,
        error: error.message,
        stdout: error.stdout || "",
        stderr: error.stderr || ""
      },
      { status: 500 }
    );
  }
}

function buildEnv(payload, scriptId = "") {
  const dryRun = payload.mode !== "production";
  const selectedTopicTemplateJson = scriptId === "newGroup"
    ? buildSelectedTopicTemplateJson(
        Array.isArray(payload.topics) && payload.topics.length ? payload.topics : defaultTopicTemplate,
        payload.selectedTopicIds
      )
    : null;
  const tokens = readTokenEnv(payload.tokenFile || ".env.telegram-tokens.local");
  const normalizedRole = String(payload.botRole || "admin").toLowerCase();
  const roleToken = normalizedRole === "speaker" || normalizedRole === "speakerbot" || normalizedRole === "trader1"
    ? tokens.SPEAKER_BOT_TOKEN || tokens.TRADER1_BOT_TOKEN || process.env.SPEAKER_BOT_TOKEN || process.env.TRADER1_BOT_TOKEN
    : normalizedRole === "forward" || normalizedRole === "forwardbot"
      ? tokens.FORWARD_BOT_TOKEN || process.env.FORWARD_BOT_TOKEN
      : tokens.YUBITADMIN_BOT_TOKEN || process.env.YUBITADMIN_BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
  return {
    ...process.env,
    ...tokens,
    TELEGRAM_CHAT_ID: payload.chatId || process.env.TELEGRAM_CHAT_ID || "",
    TELEGRAM_BOT_TOKEN: payload.botToken || roleToken || process.env.TELEGRAM_BOT_TOKEN || tokens.YUBITADMIN_BOT_TOKEN || "",
    YUBITADMIN_BOT_TOKEN: process.env.YUBITADMIN_BOT_TOKEN || tokens.YUBITADMIN_BOT_TOKEN || "",
    SPEAKER_BOT_TOKEN: process.env.SPEAKER_BOT_TOKEN || tokens.SPEAKER_BOT_TOKEN || tokens.TRADER1_BOT_TOKEN || "",
    TRADER1_BOT_TOKEN: process.env.TRADER1_BOT_TOKEN || tokens.TRADER1_BOT_TOKEN || tokens.SPEAKER_BOT_TOKEN || "",
    FORWARD_BOT_TOKEN: process.env.FORWARD_BOT_TOKEN || tokens.FORWARD_BOT_TOKEN || "",
    JACK_BOT_TOKEN: process.env.JACK_BOT_TOKEN || tokens.JACK_BOT_TOKEN || "",
    TONY_BOT_TOKEN: process.env.TONY_BOT_TOKEN || tokens.TONY_BOT_TOKEN || "",
    TELEGRAM_THREAD_ID: String(payload.threadId || process.env.TELEGRAM_THREAD_ID || ""),
    DRY_RUN: dryRun ? "true" : "false",
    SEND_TELEGRAM: payload.sendTelegram === true && !dryRun ? "true" : "false",
    CARD_KIND: payload.cardKind || "futures",
    NEWS_MODE: payload.newsMode || "crypto",
    NEWS_LIMIT: String(payload.newsLimit || process.env.NEWS_LIMIT || 4),
    BULK_MESSAGE: payload.message || "",
    TARGET_IDS: Array.isArray(payload.targetIds) ? payload.targetIds.join(",") : "",
    TARGET_TYPE: payload.targetType || "groups",
    BOT_ROLE: payload.botRole || "admin",
    GROUP_NAME: payload.groupName || "",
    GROUP_DESCRIPTION: payload.groupDescription || "",
    TOPIC_TEMPLATE_JSON: selectedTopicTemplateJson
      ? selectedTopicTemplateJson
      : payload.topics
        ? JSON.stringify(payload.topics)
        : "",
    DELETE_DUPLICATE_TOPICS: payload.deleteTopics === false ? "false" : "true",
    TOKEN_FILE: payload.tokenFile || ".env.telegram-tokens.local"
  };
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

function runNode(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      const result = { code, stdout: stdout.trim(), stderr: stderr.trim() };
      if (code === 0) {
        resolve(result);
        return;
      }
      const error = new Error(stderr || stdout || `${args.join(" ")} exited with code ${code}`);
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  });
}
