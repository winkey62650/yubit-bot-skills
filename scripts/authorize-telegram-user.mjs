import readline from "node:readline";
import { TelegramClient, sessions } from "teleproto";
import { getDistributionRepository } from "../lib/distribution-repository.mjs";
import { authorizeTelegramUser } from "../lib/telegram-user-authorization.mjs";
import { createTelegramUserSessionStore } from "../lib/telegram-user-session.mjs";

function required(name) {
  const value = String(process.env[name] || "").trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function hiddenPrompt(label) {
  if (!process.stdin.isTTY || !process.stdout.isTTY || typeof process.stdin.setRawMode !== "function") {
    throw new Error("Telegram authorization must run in an interactive TTY");
  }
  process.stdout.write(`${label}: `);
  readline.emitKeypressEvents(process.stdin);
  const wasRaw = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  let value = "";
  try {
    return await new Promise((resolve, reject) => {
      function onKeypress(character, key = {}) {
        if (key.ctrl && key.name === "c") {
          cleanup();
          reject(new Error("Authorization cancelled"));
          return;
        }
        if (key.name === "return" || key.name === "enter") {
          cleanup();
          process.stdout.write("\n");
          resolve(value.trim());
          return;
        }
        if (key.name === "backspace") {
          value = value.slice(0, -1);
          return;
        }
        if (typeof character === "string" && !key.ctrl && !key.meta) value += character;
      }
      function cleanup() {
        process.stdin.off("keypress", onKeypress);
      }
      process.stdin.on("keypress", onKeypress);
    });
  } finally {
    process.stdin.setRawMode(Boolean(wasRaw));
    process.stdin.pause();
  }
}

const apiId = Number(required("TELEGRAM_API_ID"));
const apiHash = required("TELEGRAM_API_HASH");
if (!Number.isSafeInteger(apiId) || apiId <= 0) throw new Error("TELEGRAM_API_ID must be a positive integer");

const repository = await getDistributionRepository();
const store = createTelegramUserSessionStore({
  repository,
  encryptionKey: required("TELEGRAM_USER_SESSION_ENCRYPTION_KEY"),
  expectedUsername: process.env.TELEGRAM_USER_PUBLISHER_USERNAME || "Serenity_Crypto"
});
const client = new TelegramClient(new sessions.StringSession(""), apiId, apiHash, {
  connectionRetries: 5,
  autoReconnect: true
});

try {
  const status = await authorizeTelegramUser({
    client,
    store,
    apiCredentials: { apiId, apiHash },
    phoneNumber: () => hiddenPrompt("Telegram phone number (hidden)"),
    phoneCode: () => hiddenPrompt("Telegram login code (hidden)"),
    password: () => hiddenPrompt("Telegram 2FA password (hidden)"),
    onError: () => process.stdout.write("Telegram rejected an authorization step; please retry.\n")
  });
  process.stdout.write(`Authorized ${status.username ? `@${status.username}` : "Telegram user"}; encrypted server session saved.\n`);
} finally {
  await client.disconnect().catch(() => undefined);
}
