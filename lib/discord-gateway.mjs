import {
  buildDiscordRelayPayload,
  findDiscordRoutesForMessage,
} from "./discord-domain.mjs";
import {
  getDiscordConfig,
  getDiscordGatewayStatus,
  writeDiscordGatewayStatus,
} from "./discord-service.mjs";

function normalizeNow(value) {
  if (value instanceof Date) return value;
  return value ? new Date(value) : new Date();
}

function sanitizeError(error, token = "") {
  let message = String(error?.message || error || "Unknown Discord Gateway error.");
  if (token) message = message.split(token).join("[redacted]");
  return message.slice(0, 1_000);
}

function getClientIdentity(client, fallback = {}) {
  return {
    botId: String(client?.user?.id || fallback.botId || ""),
    username: String(client?.user?.username || fallback.username || ""),
    guildCount: Number(client?.guilds?.cache?.size ?? fallback.guildCount ?? 0),
  };
}

export async function writeDiscordGatewayHeartbeat(client, options = {}) {
  const now = normalizeNow(options.now);
  const existing = await getDiscordGatewayStatus({
    ...options,
    now,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  const identity = getClientIdentity(client, existing);

  return writeDiscordGatewayStatus(
    {
      ...identity,
      state: String(options.state || "ready"),
      lastHeartbeatAt: now.toISOString(),
      lastDeliveryAt: existing.lastDeliveryAt || null,
      lastError:
        options.lastError === undefined
          ? existing.lastError || null
          : sanitizeError(options.lastError, options.token),
    },
    options,
  );
}

export async function relayDiscordMessage(message, options = {}) {
  const now = normalizeNow(options.now);
  const config = await getDiscordConfig(options);
  const routes = findDiscordRoutesForMessage(config, message, {
    botId: options.client?.user?.id,
  });
  const payload = buildDiscordRelayPayload(message);

  if (routes.length === 0 || !payload) {
    return {
      matched: routes.length,
      delivered: 0,
      failed: 0,
      results: [],
    };
  }

  const results = [];
  for (const route of routes) {
    try {
      const channel = await options.client?.channels?.fetch?.(route.targetChannelId);
      if (!channel || typeof channel.send !== "function") {
        throw new Error(`Discord target channel ${route.targetChannelId} is unavailable.`);
      }

      const sent = await channel.send(payload);
      results.push({
        ok: true,
        targetGuildId: route.targetGuildId,
        targetChannelId: route.targetChannelId,
        targetMessageId: String(sent?.id || ""),
      });
    } catch (error) {
      results.push({
        ok: false,
        targetGuildId: route.targetGuildId,
        targetChannelId: route.targetChannelId,
        error: sanitizeError(error, options.token),
      });
    }
  }

  const delivered = results.filter((result) => result.ok).length;
  const failed = results.length - delivered;
  const existing = await getDiscordGatewayStatus({
    ...options,
    now,
    staleAfterMs: Number.MAX_SAFE_INTEGER,
  });
  const identity = getClientIdentity(options.client, existing);

  await writeDiscordGatewayStatus(
    {
      ...identity,
      state: "ready",
      lastHeartbeatAt: now.toISOString(),
      lastDeliveryAt: delivered > 0 ? now.toISOString() : existing.lastDeliveryAt || null,
      lastError:
        failed > 0
          ? results
              .filter((result) => !result.ok)
              .map((result) => result.error)
              .join("; ")
              .slice(0, 1_000)
          : null,
    },
    options,
  );

  return {
    matched: routes.length,
    delivered,
    failed,
    results,
  };
}

export default relayDiscordMessage;
