const DEFAULT_DEMO_CHAT_ID = "-1003710405969";

const GROUP_IDENTITY_METHODS = new Set([
  "sendMessage",
  "sendPhoto",
  "sendVideo",
  "sendDocument",
  "sendAnimation",
  "sendAudio",
  "sendVoice",
  "sendMediaGroup",
  "copyMessage",
  "copyMessages",
  "editMessageText",
  "editMessageCaption",
  "editMessageMedia"
]);

function flag(value) {
  return /^(1|true|yes|on)$/i.test(String(value ?? "").trim());
}

function chatId(payload = {}) {
  return String(payload.chat_id ?? payload.chatId ?? "").trim();
}

export function groupIdentityChatId(env = process.env) {
  return String(env.DEMO_TELEGRAM_CHAT_ID || DEFAULT_DEMO_CHAT_ID).trim();
}

export function isGroupIdentityDelivery(method, payload = {}, env = process.env) {
  if (!flag(env.TELEGRAM_GROUP_IDENTITY_REQUIRED)) return false;
  if (!GROUP_IDENTITY_METHODS.has(String(method))) return false;
  return chatId(payload) === groupIdentityChatId(env);
}

function notConfiguredError() {
  const error = new Error(
    "Demo Academy 群身份发送尚未配置。已停止发送，以免 Telegram 显示具体 Bot 名称和头像。"
  );
  error.code = "TELEGRAM_GROUP_IDENTITY_NOT_CONFIGURED";
  return error;
}

export function createTelegramDelivery(options = {}) {
  const env = options.env ?? process.env;
  const botApiCall = options.botApiCall;
  const groupIdentityCall = options.groupIdentityCall;

  if (typeof botApiCall !== "function") {
    throw new TypeError("botApiCall is required");
  }

  return async function deliverTelegram(botToken, method, payload = {}) {
    if (!isGroupIdentityDelivery(method, payload, env)) {
      return botApiCall(botToken, method, payload);
    }
    if (typeof groupIdentityCall !== "function") {
      throw notConfiguredError();
    }
    return groupIdentityCall(botToken, method, payload);
  };
}

export function telegramGroupIdentityStatus(env = process.env) {
  const required = flag(env.TELEGRAM_GROUP_IDENTITY_REQUIRED);
  const credentialsReady = Boolean(
    String(env.TELEGRAM_API_ID || "").trim()
    && String(env.TELEGRAM_API_HASH || "").trim()
  );
  return {
    required,
    credentialsReady,
    ready: required && credentialsReady,
    chatId: groupIdentityChatId(env)
  };
}
