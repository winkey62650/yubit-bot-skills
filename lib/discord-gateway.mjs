import {
  buildDiscordRelayPayload,
  findDiscordRoutesForMessage,
} from "./discord-domain.mjs";
import {
  getDiscordConfig,
  getDiscordGatewayStatus,
  writeDiscordGatewayStatus,
} from "./discord-service.mjs";
import { getDistributionRepository } from "./distribution-repository.mjs";

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
  const repository = options.repository || await getDistributionRepository();
  const repositoryOptions = { ...options, repository };
  const config = await getDiscordConfig(repositoryOptions);
  const routes = findDiscordRoutesForMessage(config, message, {
    botId: options.client?.user?.id,
  });
  const payload = buildDiscordRelayPayload(message);

  if (routes.length === 0 || !payload) {
    return {
      matched: routes.length,
      delivered: 0,
      skipped: 0,
      failed: 0,
      results: [],
    };
  }

  const results = [];
  const sourceMessageId = String(message?.id || "").trim();
  for (const route of routes) {
    const idempotencyKey = sourceMessageId
      ? `discord:relay:${sourceMessageId}:${route.targetGuildId}:${route.targetChannelId}`
      : "";
    try {
      if (idempotencyKey) {
        const previous = await repository.getMeta(idempotencyKey);
        if (previous?.status === "success") {
          results.push({
            ok: true,
            skipped: true,
            targetGuildId: route.targetGuildId,
            targetChannelId: route.targetChannelId,
            targetMessageId: String(previous.targetMessageId || ""),
          });
          continue;
        }
      }

      const channel = await options.client?.channels?.fetch?.(route.targetChannelId);
      if (!channel || typeof channel.send !== "function") {
        throw new Error(`Discord target channel ${route.targetChannelId} is unavailable.`);
      }

      const sent = await channel.send(payload);
      if (idempotencyKey) {
        await repository.setMeta(idempotencyKey, {
          status: "success",
          sourceMessageId,
          sourceGuildId: String(message?.guildId || message?.guild?.id || ""),
          sourceChannelId: String(message?.channelId || message?.channel?.id || ""),
          targetGuildId: route.targetGuildId,
          targetChannelId: route.targetChannelId,
          targetMessageId: String(sent?.id || ""),
          deliveredAt: now.toISOString(),
        });
      }
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

  const delivered = results.filter((result) => result.ok && !result.skipped).length;
  const skipped = results.filter((result) => result.skipped).length;
  const failed = results.filter((result) => !result.ok).length;
  const existing = await getDiscordGatewayStatus({
    ...repositoryOptions,
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
    repositoryOptions,
  );

  return {
    matched: routes.length,
    delivered,
    skipped,
    failed,
    results,
  };
}

export default relayDiscordMessage;
