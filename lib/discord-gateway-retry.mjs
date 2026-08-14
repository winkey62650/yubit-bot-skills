const DEFAULT_RETRY_DELAY_MS = 60_000;
const RESET_GRACE_MS = 2_000;

export function getDiscordGatewayRetryAt(error, options = {}) {
  const nowMs = options.now instanceof Date
    ? options.now.getTime()
    : Number(options.now ?? Date.now());
  const message = String(error?.message || error || "");
  const match = message.match(/resets at\s+([^\s,;]+)/i);
  const parsedResetMs = match ? Date.parse(match[1]) : Number.NaN;

  if (Number.isFinite(parsedResetMs) && parsedResetMs > nowMs) {
    return new Date(parsedResetMs + RESET_GRACE_MS);
  }

  return new Date(nowMs + DEFAULT_RETRY_DELAY_MS);
}

