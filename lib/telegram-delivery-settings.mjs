import { readJson } from "./json-store.js";

export function normalizeTelegramDeliverySettings(value = {}, env = process.env) {
  const explicitMode = String(env.TELEGRAM_PUBLISHER_MODE || "").trim().toLowerCase();
  const userModeRequired = String(env.NODE_ENV || "").trim().toLowerCase() === "production"
    || /^(1|true|yes|on)$/i.test(String(env.TELEGRAM_USER_PUBLISHER_REQUIRED || "").trim());
  const fallback = explicitMode === "bot" || explicitMode === "user"
    ? explicitMode
    : userModeRequired ? "user" : "bot";
  return {
    telegramPublishMode: value.telegramPublishMode === "bot" || value.telegramPublishMode === "user"
      ? value.telegramPublishMode
      : fallback,
    telegramForwardMode: value.telegramForwardMode === "bot" || value.telegramForwardMode === "user"
      ? value.telegramForwardMode
      : fallback
  };
}

export async function readTelegramDeliverySettings(env = process.env) {
  const saved = await readJson("workspace-state/settings.json", null);
  return normalizeTelegramDeliverySettings(saved?.state || {}, env);
}

export function applyTelegramDeliveryMode(env, settings, purpose = "publish") {
  const mode = purpose === "forward" ? settings.telegramForwardMode : settings.telegramPublishMode;
  return {
    ...env,
    TELEGRAM_PUBLISHER_MODE: mode,
    TELEGRAM_USER_PUBLISHER_REQUIRED: mode === "user" ? "true" : "false",
    TELEGRAM_DESKTOP_PUBLISHER_REQUIRED: mode === "user" ? String(env.TELEGRAM_DESKTOP_PUBLISHER_REQUIRED || "true") : "false"
  };
}

export async function telegramDeliveryEnvironment(purpose = "publish", env = process.env) {
  return applyTelegramDeliveryMode(env, await readTelegramDeliverySettings(env), purpose);
}
