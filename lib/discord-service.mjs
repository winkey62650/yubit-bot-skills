import {
  DISCORD_CATEGORY_NAME,
  buildDiscordInitializationPlan,
  buildDiscordInstallUrl,
  normalizeDiscordConfig,
} from "./discord-domain.mjs";
import { getDistributionRepository } from "./distribution-repository.mjs";
import {
  getDiscordCredentialStatus,
  loadDiscordCredentials,
} from "./discord-credentials.mjs";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_CONFIG_META_KEY = "discord:config";
const DISCORD_GATEWAY_META_KEY = "discord:gateway";
const DISCORD_PERMISSIONS = Object.freeze({
  ADMINISTRATOR: 1n << 3n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
});

function permissionBits(value) {
  try {
    return BigInt(String(value || "0"));
  } catch {
    return 0n;
  }
}

function applyPermissionOverwrite(permissions, overwrite) {
  const allow = permissionBits(overwrite?.allow);
  const deny = permissionBits(overwrite?.deny);
  return (permissions & ~deny) | allow;
}

function resolveChannelPermissions({ guildId, botId, roles, member, channel }) {
  const rolesById = new Map((Array.isArray(roles) ? roles : []).map((role) => [String(role.id), role]));
  const memberRoleIds = (Array.isArray(member?.roles) ? member.roles : []).map(String);
  let permissions = permissionBits(rolesById.get(String(guildId))?.permissions);
  for (const roleId of memberRoleIds) {
    permissions |= permissionBits(rolesById.get(roleId)?.permissions);
  }
  if ((permissions & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n) {
    return Object.fromEntries(Object.keys(DISCORD_PERMISSIONS).map((key) => [key, true]));
  }

  const overwrites = Array.isArray(channel?.permission_overwrites)
    ? channel.permission_overwrites
    : [];
  const everyone = overwrites.find((item) => (
    Number(item?.type) === 0 && String(item?.id) === String(guildId)
  ));
  if (everyone) permissions = applyPermissionOverwrite(permissions, everyone);

  let roleAllow = 0n;
  let roleDeny = 0n;
  for (const overwrite of overwrites) {
    if (Number(overwrite?.type) !== 0 || !memberRoleIds.includes(String(overwrite?.id))) continue;
    roleAllow |= permissionBits(overwrite.allow);
    roleDeny |= permissionBits(overwrite.deny);
  }
  permissions = (permissions & ~roleDeny) | roleAllow;

  const memberOverwrite = overwrites.find((item) => (
    Number(item?.type) === 1 && String(item?.id) === String(botId)
  ));
  if (memberOverwrite) permissions = applyPermissionOverwrite(permissions, memberOverwrite);

  return Object.fromEntries(Object.entries(DISCORD_PERMISSIONS).map(([key, bit]) => [
    key,
    (permissions & bit) !== 0n,
  ]));
}

async function getRuntimeOptions(options = {}) {
  const repository = await resolveRepository(options);
  const explicit = {
    appId: String(options.appId ?? "").trim(),
    publicKey: String(options.publicKey ?? "").trim(),
    botToken: String(options.token ?? options.botToken ?? "").trim(),
  };
  const credentialStatus = await getDiscordCredentialStatus({ repository });
  let stored = { appId: "", publicKey: "", botToken: "" };
  if (credentialStatus.configured && (!explicit.appId || !explicit.publicKey || !explicit.botToken)) {
    stored = await loadDiscordCredentials({
      repository,
      encryptionKey: options.encryptionKey,
    });
  }
  return {
    appId: explicit.appId || stored.appId,
    publicKey: explicit.publicKey || stored.publicKey,
    botToken: explicit.botToken || stored.botToken,
    fetchImpl: options.fetchImpl || globalThis.fetch,
    credentialStatus,
  };
}

async function resolveRepository(options = {}) {
  return options.repository || getDistributionRepository();
}

function sanitizeDiscordError(message, token = "") {
  let sanitized = String(message || "Discord request failed.")
    .replace(/Bot\s+[A-Za-z0-9._-]+/gi, "Bot [redacted]");
  if (token) sanitized = sanitized.split(token).join("[redacted]");
  return sanitized.slice(0, 1_000);
}

async function discordRequest(path, {
  botToken,
  fetchImpl,
  method = "GET",
  body,
} = {}) {
  if (!botToken) {
    throw new Error("Discord Bot credentials are not configured.");
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
  const runtime = await getRuntimeOptions({ ...options, repository });
  const status = {
    configured: Boolean(runtime.appId && runtime.botToken),
    credentials: runtime.credentialStatus,
    publicKeyConfigured: Boolean(runtime.publicKey),
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
    status.error = "Discord Bot credentials are not configured.";
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

  const runtime = await getRuntimeOptions({ ...options, repository });
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

export async function sendDiscordMessage(channelId, payload = {}, options = {}) {
  const normalizedChannelId = String(channelId || "").trim();
  const normalizedPayload = typeof payload === "string" ? { content: payload } : (payload || {});
  const normalizedContent = String(normalizedPayload.content || "").trim();
  const embeds = Array.isArray(normalizedPayload.embeds)
    ? normalizedPayload.embeds.filter((embed) => embed && typeof embed === "object")
    : [];
  const imageUrl = String(normalizedPayload.imageUrl || "").trim();
  if (imageUrl && !embeds.some((embed) => embed?.image?.url === imageUrl)) {
    embeds.push({ image: { url: imageUrl } });
  }
  if (!normalizedChannelId || (!normalizedContent && !embeds.length)) {
    throw new Error("Discord channelId and message content are required.");
  }
  const repository = await resolveRepository(options);
  const runtime = await getRuntimeOptions({ ...options, repository });
  return discordRequest(`/channels/${encodeURIComponent(normalizedChannelId)}/messages`, {
    ...runtime,
    method: "POST",
    body: {
      ...(normalizedContent ? { content: normalizedContent } : {}),
      ...(embeds.length ? { embeds } : {}),
      allowed_mentions: { parse: [] },
    },
  });
}

export async function sendDiscordTestMessage(channelId, content, options = {}) {
  return sendDiscordMessage(channelId, { content }, options);
}

export async function sendDiscordManualPublish({
  channelIds = [],
  content = "",
  imageUrl = "",
  embeds = [],
} = {}, options = {}) {
  const targets = [...new Set(
    (Array.isArray(channelIds) ? channelIds : [])
      .map((channelId) => String(channelId || "").trim())
      .filter(Boolean),
  )];
  const normalizedContent = String(content || "").trim();
  const normalizedImageUrl = String(imageUrl || "").trim();
  const normalizedEmbeds = Array.isArray(embeds) ? embeds : [];

  if (!targets.length) {
    throw new Error("Select at least one Discord channel.");
  }
  if (!normalizedContent && !normalizedImageUrl && !normalizedEmbeds.length) {
    throw new Error("Enter message content or an image URL.");
  }

  const repository = await resolveRepository(options);
  const runtime = await getRuntimeOptions({ ...options, repository });
  const config = await getDiscordConfig({ repository });
  const allowedChannelIds = new Set(
    Object.values(config.guilds || {}).flatMap((guild) =>
      (Array.isArray(guild?.channels) ? guild.channels : [])
        .map((channel) => String(channel?.channelId || "").trim())
        .filter(Boolean),
    ),
  );
  const results = [];

  for (const channelId of targets) {
    if (!allowedChannelIds.has(channelId)) {
      results.push({
        ok: false,
        channelId,
        error: "Discord channel is not an initialized destination.",
      });
      continue;
    }
    try {
      const sent = await sendDiscordMessage(
        channelId,
        {
          content: normalizedContent,
          imageUrl: normalizedImageUrl,
          embeds: normalizedEmbeds,
        },
        {
          ...options,
          repository,
          botToken: runtime.botToken,
          fetchImpl: runtime.fetchImpl,
        },
      );
      results.push({
        ok: true,
        channelId,
        messageId: String(sent?.id || ""),
      });
    } catch (error) {
      results.push({
        ok: false,
        channelId,
        error: sanitizeDiscordError(error?.message, runtime.botToken),
      });
    }
  }

  const delivered = results.filter((result) => result.ok).length;
  return {
    attempted: targets.length,
    delivered,
    failed: targets.length - delivered,
    results,
  };
}

export async function checkDiscordHealth(options = {}) {
  const repository = await resolveRepository(options);
  const runtime = await getRuntimeOptions({ ...options, repository });
  const config = await getDiscordConfig({ repository });
  const checkedAt = new Date().toISOString();
  const bot = await discordRequest("/users/@me", runtime);
  const botId = String(bot?.id || "");
  const guildResults = [];

  for (const configuredGuild of Object.values(config.guilds || {})) {
    const guildId = String(configuredGuild?.guildId || "");
    try {
      const [liveGuild, liveChannels, roles, member] = await Promise.all([
        discordRequest(`/guilds/${encodeURIComponent(guildId)}`, runtime),
        discordRequest(`/guilds/${encodeURIComponent(guildId)}/channels`, runtime),
        discordRequest(`/guilds/${encodeURIComponent(guildId)}/roles`, runtime),
        discordRequest(`/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(botId)}`, runtime),
      ]);
      const channelsById = new Map(
        (Array.isArray(liveChannels) ? liveChannels : []).map((channel) => [String(channel.id), channel]),
      );
      const channels = (configuredGuild.channels || []).map((configuredChannel) => {
        const channelId = String(configuredChannel.channelId || "");
        const liveChannel = channelsById.get(channelId);
        if (!liveChannel) {
          return {
            templateId: Number(configuredChannel.templateId),
            channelId,
            name: String(configuredChannel.name || ""),
            available: false,
            type: null,
            canView: false,
            canSend: false,
            canEmbed: false,
            canAttach: false,
            error: "Channel no longer exists or is not visible to the Bot.",
          };
        }
        const permissions = resolveChannelPermissions({
          guildId,
          botId,
          roles,
          member,
          channel: liveChannel,
        });
        const canView = permissions.VIEW_CHANNEL === true;
        return {
          templateId: Number(configuredChannel.templateId),
          channelId,
          name: String(liveChannel.name || configuredChannel.name || ""),
          available: true,
          type: Number(liveChannel.type),
          canView,
          canSend: canView && permissions.SEND_MESSAGES === true,
          canEmbed: canView && permissions.EMBED_LINKS === true,
          canAttach: canView && permissions.ATTACH_FILES === true,
          error: "",
        };
      });
      guildResults.push({
        guildId,
        guildName: String(liveGuild?.name || configuredGuild.guildName || ""),
        available: true,
        error: "",
        channels,
      });
    } catch (error) {
      guildResults.push({
        guildId,
        guildName: String(configuredGuild?.guildName || guildId),
        available: false,
        error: sanitizeDiscordError(error?.message, runtime.botToken),
        channels: (configuredGuild.channels || []).map((channel) => ({
          templateId: Number(channel.templateId),
          channelId: String(channel.channelId || ""),
          name: String(channel.name || ""),
          available: false,
          type: null,
          canView: false,
          canSend: false,
          canEmbed: false,
          canAttach: false,
          error: "Server permission check failed.",
        })),
      });
    }
  }

  const allChannels = guildResults.flatMap((guild) => guild.channels);
  const sendableChannels = allChannels.filter((channel) => channel.canSend).length;
  return {
    checkedAt,
    bot: { id: botId, username: String(bot?.username || "") },
    summary: {
      guilds: guildResults.length,
      totalChannels: allChannels.length,
      sendableChannels,
      blockedChannels: allChannels.length - sendableChannels,
    },
    guilds: guildResults,
  };
}
