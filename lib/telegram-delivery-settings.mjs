import { readJson } from "./json-store.js";

export function normalizeTelegramDeliverySettings(value = {}, env = process.env) {
  const explicitMode = String(env.TELEGRAM_PUBLISHER_MODE || "").trim().toLowerCase();
  const userModeRequired = /^(1|true|yes|on)$/i.test(String(env.TELEGRAM_USER_PUBLISHER_REQUIRED || "").trim());
  const fallback = explicitMode === "bot" || explicitMode === "user"
    ? explicitMode
    : userModeRequired ? "user" : "bot";
  return {
    telegramPublishMode: value.telegramPublishMode === "bot" || value.telegramPublishMode === "user"
      ? value.telegramPublishMode
      : fallback,
    telegramForwardMode: value.telegramForwardMode === "bot" || value.telegramForwardMode === "user"
      ? value.telegramForwardMode
      : fallback,
    telegramPublishUserId: String(value.telegramPublishUserId || "").trim() || String(env.TELEGRAM_USER_PUBLISHER_ID || "").trim(),
    telegramForwardUserId: String(value.telegramForwardUserId || "").trim() || String(env.TELEGRAM_USER_PUBLISHER_ID || "").trim()
  };
}

export async function readTelegramDeliverySettings(env = process.env) {
  const saved = await readJson("workspace-state/settings.json", null);
  return normalizeTelegramDeliverySettings(saved?.state || {}, env);
}

export function applyTelegramDeliveryMode(env, settings, purpose = "publish") {
  const mode = purpose === "forward" ? settings.telegramForwardMode : settings.telegramPublishMode;
  const userId = purpose === "forward" ? settings.telegramForwardUserId : settings.telegramPublishUserId;
  return {
    ...env,
    TELEGRAM_PUBLISHER_MODE: mode,
    TELEGRAM_USER_PUBLISHER_REQUIRED: mode === "user" ? "true" : "false",
    TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: mode === "user" ? String(env.TELEGRAM_DESKTOP_PUBLISHER_REQUIRED || "true") : "false",
    // Pass the selected user account ID so telegramMtprotoCall can pick the right session
    TELEGRAM_USER_PUBLISHER_ID: userId || env.TELEGRAM_USER_PUBLISHER_ID || ""
  };
}

export async function telegramDeliveryEnvironment(purpose = "publish", env = process.env) {
  return applyTelegramDeliveryMode(env, await readTelegramDeliverySettings(env), purpose);
}
