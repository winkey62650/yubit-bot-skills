import {
  DISCORD_CATEGORY_NAME,
  buildDiscordInitializationPlan,
  buildDiscordInstallUrl,
  normalizeDiscordConfig,
} from "./discord-domain.mjs";
import { getDistributionRepository } from "./distribution-repository.mjs";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_CONFIG_META_KEY = "discord:config";
const DISCORD_GATEWAY_META_KEY = "discord:gateway";

function getRuntimeOptions(options = {}) {
  return {
    appId: String(options.appId ?? process.env.DISCORD_APP_ID ?? "").trim(),
    botToken: String(options.token ?? options.botToken ?? process.env.DISCORD_BOT_TOKEN ?? "").trim(),
    fetchImpl: options.fetchImpl || globalThis.fetch,
  };
}

async function resolveRepository(options = {}) {
  return options.repository || getDistributionRepository();
}

function sanitizeDiscordError(message) {
  return String(message || "Discord request failed.")
    .replace(/Bot\s+[A-Za-z0-9._-]+/gi, "Bot [redacted]");
}

async function discordRequest(path, {
  botToken,
  fetchImpl,
  method = "GET",
  body,
} = {}) {
  if (!botToken) {
    throw new Error("DISCORD_BOT_TOKEN is not configured.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Discord fetch implementation is unavailable.");
  }

  const response = await fetchImpl(`${DISCORD_API_BASE_URL}${path}`, {
    ...(method !== "GET" ? { method } : {}),
    headers: {
      Authorization: `Bot ${botToken}`,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }

  if (!response.ok) {
    const detail = payload?.message || response.statusText || `HTTP ${response.status}`;
    throw new Error(sanitizeDiscordError(`Discord API: ${detail}`));
  }
  return payload;
}

export async function getDiscordConfig(options = {}) {
  const repository = await resolveRepository(options);
  const stored = await repository.getMeta(DISCORD_CONFIG_META_KEY);
  return normalizeDiscordConfig(stored || {});
}

export async function saveDiscordConfig(value, options = {}) {
  const repository = await resolveRepository(options);
  const config = normalizeDiscordConfig(value);
  await repository.setMeta(DISCORD_CONFIG_META_KEY, config);
  return config;
}

export async function getDiscordStatus(options = {}) {
  const repository = await resolveRepository(options);
  const [config, gateway] = await Promise.all([
    getDiscordConfig({ ...options, repository }),
    getDiscordGatewayStatus({ ...options, repository }),
  ]);
  const runtime = getRuntimeOptions(options);
  const status = {
    configured: Boolean(runtime.appId && runtime.botToken),
    publicKeyConfigured: Boolean(
      String(options.publicKey ?? process.env.DISCORD_PUBLIC_KEY ?? "").trim(),
    ),
    connected: false,
    appId: runtime.appId,
    installUrl: runtime.appId ? buildDiscordInstallUrl(runtime.appId) : "",
    bot: null,
    guilds: [],
    config,
    gateway,
    error: "",
  };

  if (!runtime.botToken) {
    status.error = "DISCORD_BOT_TOKEN is not configured.";
    return status;
  }

  try {
    const [bot, guilds] = await Promise.all([
      discordRequest("/users/@me", runtime),
      discordRequest("/users/@me/guilds", runtime),
    ]);
    status.connected = true;
    status.bot = {
      id: String(bot?.id || ""),
      username: String(bot?.username || ""),
      globalName: String(bot?.global_name || ""),
    };
    status.guilds = (Array.isArray(guilds) ? guilds : [])
      .map((guild) => ({
        id: String(guild.id || ""),
        name: String(guild.name || ""),
        icon: guild.icon || null,
        owner: guild.owner === true,
        permissions: String(guild.permissions || ""),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
  } catch (error) {
    status.error = sanitizeDiscordError(error?.message);
  }

  return status;
}

export async function writeDiscordGatewayStatus(value = {}, options = {}) {
  const repository = await resolveRepository(options);
  const status = {
    state: String(value?.state || "offline"),
    botId: String(value?.botId || ""),
    username: String(value?.username || ""),
    guildCount: Number(value?.guildCount || 0),
    lastHeartbeatAt: String(value?.lastHeartbeatAt || new Date().toISOString()),
    lastDeliveryAt: String(value?.lastDeliveryAt || ""),
    lastError: sanitizeDiscordError(value?.lastError || ""),
  };
  await repository.setMeta(DISCORD_GATEWAY_META_KEY, status);
  return status;
}

export async function getDiscordGatewayStatus(options = {}) {
  const repository = await resolveRepository(options);
  const stored = await repository.getMeta(DISCORD_GATEWAY_META_KEY);
  if (!stored) {
    return {
      state: "offline",
      online: false,
      botId: "",
      username: "",
      guildCount: 0,
      lastHeartbeatAt: "",
      lastDeliveryAt: "",
      lastError: "",
    };
  }

  const heartbeatAt = Date.parse(String(stored.lastHeartbeatAt || ""));
  const now = options.now instanceof Date ? options.now : new Date(options.now || Date.now());
  const staleAfterMs = Number(options.staleAfterMs || 90_000);
  const online = (
    Number.isFinite(heartbeatAt)
    && now.getTime() - heartbeatAt <= staleAfterMs
    && stored.state === "ready"
  );
  return {
    state: online ? "ready" : stored.state === "ready" ? "stale" : String(stored.state || "offline"),
    online,
    botId: String(stored.botId || ""),
    username: String(stored.username || ""),
    guildCount: Number(stored.guildCount || 0),
    lastHeartbeatAt: String(stored.lastHeartbeatAt || ""),
    lastDeliveryAt: String(stored.lastDeliveryAt || ""),
    lastError: sanitizeDiscordError(stored.lastError || ""),
  };
}

export async function updateDiscordSettings({
  demoGuildId,
  syncEnabled,
} = {}, options = {}) {
  const repository = await resolveRepository(options);
  const config = await getDiscordConfig({ repository });
  const normalizedDemoGuildId = demoGuildId === undefined
    ? config.demoGuildId
    : String(demoGuildId || "").trim();
  const nextConfig = normalizeDiscordConfig({
    ...config,
    demoGuildId: normalizedDemoGuildId,
    syncEnabled: syncEnabled === undefined ? config.syncEnabled : syncEnabled === true,
  });

  if (nextConfig.demoGuildId && !nextConfig.guilds[nextConfig.demoGuildId]) {
    throw new Error("The selected Discord Demo server has not been initialized.");
  }
  if (nextConfig.syncEnabled && !nextConfig.demoGuildId) {
    throw new Error("Select an initialized Discord Demo server before enabling synchronization.");
  }
  if (nextConfig.syncEnabled && !nextConfig.routes.length) {
    throw new Error("Initialize at least one target server with matching channels before enabling synchronization.");
  }
  return saveDiscordConfig(nextConfig, { repository });
}

export async function initializeDiscordGuild({
  guildId,
  selectedTemplateIds,
  dryRun = false,
  markAsDemo = false,
} = {}, options = {}) {
  const repository = await resolveRepository(options);
  const normalizedGuildId = String(guildId || "").trim();
  if (!normalizedGuildId) {
    throw new Error("Discord guildId is required.");
  }

  const runtime = getRuntimeOptions(options);
  const [guild, channels] = await Promise.all([
    discordRequest(`/guilds/${encodeURIComponent(normalizedGuildId)}`, runtime),
    discordRequest(`/guilds/${encodeURIComponent(normalizedGuildId)}/channels`, runtime),
  ]);
  const plan = buildDiscordInitializationPlan({ channels, selectedTemplateIds });

  if (dryRun) {
    return {
      dryRun: true,
      guild: {
        id: normalizedGuildId,
        name: String(guild?.name || ""),
        categoryId: plan.category.id,
        channels: plan.channels.map((channel) => ({
          templateId: channel.templateId,
          channelId: channel.id,
          name: channel.name,
          action: channel.action,
        })),
      },
      plan,
    };
  }

  let categoryId = plan.category.id;
  if (plan.category.action === "create") {
    const createdCategory = await discordRequest(
      `/guilds/${encodeURIComponent(normalizedGuildId)}/channels`,
      {
        ...runtime,
        method: "POST",
        body: {
          name: DISCORD_CATEGORY_NAME,
          type: 4,
          position: 0,
        },
      },
    );
    categoryId = String(createdCategory.id || "");
  }

  const initializedChannels = [];
  for (const channelPlan of plan.channels) {
    let channelId = channelPlan.id;
    if (channelPlan.action === "create") {
      const createdChannel = await discordRequest(
        `/guilds/${encodeURIComponent(normalizedGuildId)}/channels`,
        {
          ...runtime,
          method: "POST",
          body: {
            name: channelPlan.name,
            type: 0,
            parent_id: categoryId,
            position: channelPlan.position,
          },
        },
      );
      channelId = String(createdChannel.id || "");
    }
    initializedChannels.push({
      templateId: channelPlan.templateId,
      channelId,
      name: channelPlan.name,
    });
  }

  const config = await getDiscordConfig({ repository });
  const previousChannels = Array.isArray(config.guilds?.[normalizedGuildId]?.channels)
    ? config.guilds[normalizedGuildId].channels
    : [];
  const channelsByTemplateId = new Map(
    previousChannels.map((channel) => [Number(channel.templateId), channel]),
  );
  for (const channel of initializedChannels) {
    channelsByTemplateId.set(Number(channel.templateId), channel);
  }
  const mergedChannels = [...channelsByTemplateId.values()].sort(
    (left, right) => Number(left.templateId) - Number(right.templateId),
  );
  const nextConfig = {
    ...config,
    demoGuildId: markAsDemo ? normalizedGuildId : config.demoGuildId,
    guilds: {
      ...config.guilds,
      [normalizedGuildId]: {
        guildId: normalizedGuildId,
        guildName: String(guild?.name || ""),
        categoryId,
        channels: mergedChannels,
        initializedAt: new Date().toISOString(),
      },
    },
  };
  const savedConfig = await saveDiscordConfig(nextConfig, { repository });

  return {
    dryRun: false,
    guild: savedConfig.guilds[normalizedGuildId],
    plan,
    config: savedConfig,
  };
}

export async function sendDiscordTestMessage(channelId, content, options = {}) {
  const normalizedChannelId = String(channelId || "").trim();
  const normalizedContent = String(content || "").trim();
  if (!normalizedChannelId || !normalizedContent) {
    throw new Error("Discord channelId and content are required.");
  }
  const runtime = getRuntimeOptions(options);
  return discordRequest(`/channels/${encodeURIComponent(normalizedChannelId)}/messages`, {
    ...runtime,
    method: "POST",
    body: {
      content: normalizedContent,
      allowed_mentions: { parse: [] },
    },
  });
}
