const USER_PUBLISHER_METHODS = new Set([
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

export function telegramPublisherMode(env = process.env) {
  const explicit = String(env.TELEGRAM_PUBLISHER_MODE || "").trim().toLowerCase();
  if (explicit === "bot" || explicit === "user") return explicit;
  if (flag(env.TELEGRAM_USER_PUBLISHER_REQUIRED)) return "user";
  return "bot";
}

function userPublisherRequired(env = process.env) {
  return telegramPublisherMode(env) === "user";
}

function chatId(payload = {}) {
  return String(payload.chat_id ?? payload.chatId ?? "").trim();
}

function username(env) {
  return String(env.TELEGRAM_USER_PUBLISHER_USERNAME || "Serenity_Crypto")
    .trim()
    .replace(/^@/, "");
}

function botUsername(env) {
  return String(env.TELEGRAM_BOT_PUBLISHER_USERNAME || "Satoshi_geniustrader_bot")
    .trim()
    .replace(/^@/, "");
}

export function userPublisherTargetIds(env = process.env) {
  return [...new Set(
    String(env.TELEGRAM_USER_PUBLISHER_TARGETS || "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean)
  )];
}

export function isUserPublisherDelivery(method, payload = {}, env = process.env) {
  if (!userPublisherRequired(env)) return false;
  if (!USER_PUBLISHER_METHODS.has(String(method))) return false;
  return userPublisherTargetIds(env).includes(chatId(payload));
}

function notConfiguredError() {
  const error = new Error(
    "Telegram 用户发布器尚未完成授权。已停止发送，不会回退为 Bot 身份。"
  );
  error.code = "TELEGRAM_USER_PUBLISHER_NOT_CONFIGURED";
  return error;
}

function targetNotApprovedError(targetChatId) {
  const error = new Error(
    `Telegram 目标 ${targetChatId || "unknown"} 未列入用户发布器 Demo 白名单，已停止发送。`
  );
  error.code = "TELEGRAM_USER_PUBLISHER_TARGET_NOT_APPROVED";
  return error;
}

export function createTelegramDelivery(options = {}) {
  const env = options.env ?? process.env;
  const botApiCall = options.botApiCall;
  const userPublisherCall = options.userPublisherCall ?? options.groupIdentityCall;

  if (typeof botApiCall !== "function") {
    throw new TypeError("botApiCall is required");
  }

  return async function deliverTelegram(botToken, method, payload = {}) {
    const isOutbound = USER_PUBLISHER_METHODS.has(String(method));
    const publisherRequired = userPublisherRequired(env);

    if (!isOutbound || !publisherRequired) {
      return botApiCall(botToken, method, payload);
    }

    if (!isUserPublisherDelivery(method, payload, env)) {
      throw targetNotApprovedError(chatId(payload));
    }
    if (typeof userPublisherCall !== "function") {
      throw notConfiguredError();
    }
    return userPublisherCall(botToken, method, payload);
  };
}

export function telegramUserPublisherStatus(env = process.env) {
  const mode = telegramPublisherMode(env);
  const required = userPublisherRequired(env);
  const credentialsReady = mode === "bot"
    ? Boolean(String(env.SPEAKER_BOT_TOKEN || env.TRADER1_BOT_TOKEN || "").trim())
    : Boolean(
      String(env.TELEGRAM_API_ID || "").trim()
      && String(env.TELEGRAM_API_HASH || "").trim()
    );
  const encryptionReady = mode === "bot" || Boolean(
    String(env.TELEGRAM_USER_SESSION_ENCRYPTION_KEY || "").trim()
  );
  const approvedTargetIds = userPublisherTargetIds(env);
  const routingReady = approvedTargetIds.length > 0;
  return {
    mode,
    required,
    credentialsReady,
    encryptionReady,
    routingReady,
    ready: credentialsReady && encryptionReady && routingReady,
    username: mode === "bot" ? `@${botUsername(env)}` : `@${username(env)}`,
    approvedTargetIds
  };
}

// Compatibility aliases for integrations during the user-publisher migration.
export const isGroupIdentityDelivery = isUserPublisherDelivery;
export const telegramGroupIdentityStatus = telegramUserPublisherStatus;
