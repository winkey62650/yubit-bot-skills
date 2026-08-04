import { createTelegramDelivery } from "./telegram-delivery.mjs";
import { telegramMtprotoCall } from "./telegram-mtproto.mjs";
import { telegramDeliveryEnvironment } from "./telegram-delivery-settings.mjs";

async function defaultBotApiCall(botToken, method, payload = {}) {
  if (!botToken) throw new Error("TELEGRAM_TOKEN_REQUIRED");
  const response = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.ok) {
    const status = Number(response.status) || 0;
    const error = new Error(status === 429 ? "TELEGRAM_RATE_LIMITED" : `TELEGRAM_API_ERROR:${status}`);
    const retryAfter = Number(body?.parameters?.retry_after);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) error.retryAfter = retryAfter;
    throw error;
  }
  return body.result;
}

/**
 * A unified Telegram client helper that automatically routes outbound messages
 * via MTProto (User Publisher) if configured, or falls back to the standard Bot API.
 */
export async function telegramCall(botToken, method, payload = {}, options = {}) {
  const env = options.env ?? process.env;
  
  // Use "publish" scope to resolve targets if using the advanced environment resolver
  const resolvedEnv = await telegramDeliveryEnvironment("publish", env);
  
  const deliver = createTelegramDelivery({
    env: resolvedEnv,
    botApiCall: (token, botMethod, botPayload) => defaultBotApiCall(
      token,
      botMethod,
      botPayload
    ),
    userPublisherCall: options.userPublisherCall ?? telegramMtprotoCall
  });
  
  return deliver(botToken, method, payload);
}
