import { spawn } from "node:child_process";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import {
  communityDisclaimer,
  defaultTopicTemplate,
  readFirstContentVersion,
  readFirstPinnedMessages,
  topicDisplayName
} from "../templates.mjs";

const dryRun = process.env.DRY_RUN !== "false";
const chatId = process.env.TELEGRAM_CHAT_ID;
const token = process.env.TELEGRAM_BOT_TOKEN;
const configPath = await resolveConfigPath();

console.log(
  JSON.stringify(
    {
      action: "new-group-setup",
      dryRun,
      chatId: chatId || null,
      config: configPath,
      script: "setup-telegram-community.mjs"
    },
    null,
    2
  )
);

if (!chatId || !token) {
  console.log("Missing TELEGRAM_CHAT_ID or TELEGRAM_BOT_TOKEN. Showing setup plan only.");
  process.exit(0);
}

const result = await run(["setup-telegram-community.mjs"], {
  ...process.env,
  YUBIT_TG_CONFIG: configPath,
  DRY_RUN: dryRun ? "true" : "false"
});

if (result.stdout) console.log(result.stdout);
if (result.stderr) console.error(result.stderr);
process.exit(result.code);

function run(args, env) {
  return new Promise((resolve) => {
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
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

async function resolveConfigPath() {
  if (!process.env.TOPIC_TEMPLATE_JSON && !process.env.GROUP_NAME && !process.env.GROUP_DESCRIPTION) {
    return process.env.YUBIT_TG_CONFIG || "telegram-community.config.json";
  }

  const topics = process.env.TOPIC_TEMPLATE_JSON ? JSON.parse(process.env.TOPIC_TEMPLATE_JSON) : defaultTopicTemplate;
  const config = {
    chatTitle: process.env.GROUP_NAME || "",
    chatDescription:
      process.env.GROUP_DESCRIPTION ||
      "YUBIT official community. Beware of impersonators. Admins will never DM first. Trading content is for information only and is not investment advice.",
    generalTopicName: "General Chat",
    defaultParseMode: "HTML",
    dryRun: true,
    topics: topics.map((topic, index) => {
      const identity = slug(topic.id || index + 1);
      const isDefaultReadFirst = String(topic.name || "").includes("READ FIRST")
        && (!topic.announcement || topic.announcement === communityDisclaimer);
      const messages = Array.isArray(topic.messages) && topic.messages.length
        ? topic.messages
        : isDefaultReadFirst ? readFirstPinnedMessages : [];
      return {
      key: `topic_${identity}`,
      legacyKeys: [slug(topic.name), slug(topicDisplayName(topic))],
      legacyKeyPrefix: `${identity}_`,
      name: topicDisplayName(topic),
      emoji: topic.emoji || "",
      announcement: topic.announcement || (topic.name.includes("READ FIRST") ? communityDisclaimer : `<b>${escapeHtml(topic.name)}</b>`),
      imageUrl: topic.imageUrl || (topic.name.includes("READ FIRST") ? defaultDisclaimerImageUrl() : ""),
      ...(messages.length ? {
        contentVersion: topic.contentVersion || (isDefaultReadFirst ? readFirstContentVersion : ""),
        messages
      } : {}),
      iconCustomEmojiId: topic.iconCustomEmojiId || "",
      pin: true,
      close: topic.attribute === "关闭话题" || topic.attribute === "频道禁言"
    };
    })
  };
  const dir = await mkdtemp(join(tmpdir(), "yubit-group-config-"));
  const path = join(dir, "telegram-community.config.json");
  await writeFile(path, JSON.stringify(config, null, 2));
  return path;
}

function defaultDisclaimerImageUrl() {
  const base = (process.env.APP_BASE_URL || process.env.NEXT_PUBLIC_APP_URL || "https://yubit-bot-skills-academy.vercel.app").replace(/\/$/, "");
  return process.env.DISCLAIMER_IMAGE_URL || `${base}/api/media/card?kind=disclaimer`;
}

function slug(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "") || "topic";
}

function escapeHtml(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
