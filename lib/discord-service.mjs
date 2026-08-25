import {
  DISCORD_CATEGORY_NAME,
  DISCORD_DEMO_GUILD_NAME,
  buildDiscordDemoSnapshot,
  buildDiscordInitializationPlan,
  buildDiscordInstallUrl,
  normalizeDiscordConfig,
} from "./discord-domain.mjs";
import { getDistributionRepository } from "./distribution-repository.mjs";
import {
  getDiscordCredentialStatus,
  loadDiscordCredentials,
  normalizeDiscordBotToken,
} from "./discord-credentials.mjs";
import { composeManualMessage } from "./manual-cta.mjs";
import { hydrateDestinationCtas } from "./destination-cta.mjs";
import { downloadBinary } from "./http-binary-download.mjs";

const DISCORD_API_BASE_URL = "https://discord.com/api/v10";
const DISCORD_CONFIG_META_KEY = "discord:config";
const DISCORD_GATEWAY_META_KEY = "discord:gateway";
const DISCORD_PERMISSIONS = Object.freeze({
  ADMINISTRATOR: 1n << 3n,
  MANAGE_CHANNELS: 1n << 4n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
});

const REQUIRED_PERMISSION_KEYS = Object.freeze([
  "MANAGE_CHANNELS",
  "VIEW_CHANNEL",
  "SEND_MESSAGES",
  "EMBED_LINKS",
  "ATTACH_FILES",
  "READ_MESSAGE_HISTORY",
]);

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

function resolveGuildPermissions({ guildId, roles, member }) {
  const rolesById = new Map((Array.isArray(roles) ? roles : []).map((role) => [String(role.id), role]));
  let permissions = permissionBits(rolesById.get(String(guildId))?.permissions);
  for (const roleId of Array.isArray(member?.roles) ? member.roles : []) {
    permissions |= permissionBits(rolesById.get(String(roleId))?.permissions);
  }
  const administrator = (permissions & DISCORD_PERMISSIONS.ADMINISTRATOR) !== 0n;
  return Object.fromEntries(REQUIRED_PERMISSION_KEYS.map((key) => [
    key,
    administrator || (permissions & DISCORD_PERMISSIONS[key]) !== 0n,
  ]));
}

async function getRuntimeOptions(options = {}) {
  const repository = await resolveRepository(options);
  const explicit = {
    appId: String(options.appId ?? "").trim(),
    publicKey: String(options.publicKey ?? "").trim(),
    botToken: normalizeDiscordBotToken(options.token ?? options.botToken ?? ""),
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
    signal: options.signal,
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
  formData,
  signal,
} = {}) {
  if (!botToken) {
    throw new Error("Discord Bot credentials are not configured.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Discord fetch implementation is unavailable.");
  }
  signal?.throwIfAborted?.();

  const response = await fetchImpl(`${DISCORD_API_BASE_URL}${path}`, {
    ...(method !== "GET" ? { method } : {}),
    headers: {
      Authorization: `Bot ${botToken}`,
      ...(body && !formData ? { "Content-Type": "application/json" } : {}),
    },
    ...(formData ? { body: formData } : body ? { body: JSON.stringify(body) } : {}),
    signal,
  });
  signal?.throwIfAborted?.();

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
    guildDiscovery: {
      ok: false,
      error: "",
    },
    config,
    gateway,
    error: "",
  };

  if (!runtime.botToken) {
    status.error = "Discord Bot credentials are not configured.";
    return status;
  }

  try {
    const bot = await discordRequest("/users/@me", runtime);
    status.connected = true;
    status.bot = {
      id: String(bot?.id || ""),
      username: String(bot?.username || ""),
      globalName: String(bot?.global_name || ""),
    };
  } catch (error) {
    status.error = sanitizeDiscordError(error?.message, runtime.botToken);
    return status;
  }

  try {
    const guilds = await discordRequest("/users/@me/guilds", runtime);
    status.guilds = (Array.isArray(guilds) ? guilds : [])
      .map((guild) => ({
        id: String(guild.id || ""),
        name: String(guild.name || ""),
        icon: guild.icon || null,
        owner: guild.owner === true,
        permissions: String(guild.permissions || ""),
      }))
      .sort((left, right) => left.id.localeCompare(right.id));
    status.guildDiscovery.ok = true;
  } catch (error) {
    status.guildDiscovery.error = sanitizeDiscordError(error?.message, runtime.botToken);
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

export async function refreshDiscordDemoTemplate(options = {}) {
  const repository = await resolveRepository(options);
  const runtime = await getRuntimeOptions({ ...options, repository });
  const config = await getDiscordConfig({ repository });
  const guilds = await discordRequest("/users/@me/guilds", runtime);
  const liveGuilds = Array.isArray(guilds) ? guilds : [];
  const requestedGuildId = String(options.guildId || "").trim();
  const demoGuildSummary = requestedGuildId
    ? liveGuilds.find((guild) => String(guild?.id || "") === requestedGuildId)
    : liveGuilds.find((guild) => String(guild?.id || "") === String(config.demoGuildId || ""))
      || liveGuilds.find((guild) => String(guild?.name || "") === DISCORD_DEMO_GUILD_NAME)
      || (liveGuilds.length === 1 ? liveGuilds[0] : null);
  if (!demoGuildSummary?.id) {
    throw new Error(requestedGuildId
      ? "Selected Discord Demo Server is not visible to the Bot."
      : "Select a Discord Demo Server before refreshing the template.");
  }

  const demoGuildId = String(demoGuildSummary.id);
  const [guild, channels] = await Promise.all([
    discordRequest(`/guilds/${encodeURIComponent(demoGuildId)}`, runtime),
    discordRequest(`/guilds/${encodeURIComponent(demoGuildId)}/channels`, runtime),
  ]);
  const messagesByChannel = {};
  const messageStatusByChannel = {};
  const textChannels = (Array.isArray(channels) ? channels : [])
    .filter((channel) => [0, 5].includes(Number(channel?.type)));
  await Promise.all(textChannels.map(async (channel) => {
    const channelId = String(channel.id);
    try {
      messagesByChannel[channelId] = await discordRequest(
        `/channels/${encodeURIComponent(channelId)}/messages?limit=100`,
        runtime,
      );
      messageStatusByChannel[channelId] = { status: "ok", error: "" };
    } catch {
      messagesByChannel[channelId] = [];
      messageStatusByChannel[channelId] = {
        status: "unavailable",
        error: "Discord Bot lacks View Channel or Read Message History permission.",
      };
    }
  }));

  const snapshot = buildDiscordDemoSnapshot({
    guild,
    channels,
    messagesByChannel,
    messageStatusByChannel,
    capturedAt: options.now instanceof Date
      ? options.now.toISOString()
      : options.now || new Date().toISOString(),
  });
  const previousChannels = config.guilds?.[demoGuildId]?.channels || [];
  const previousByKey = new Map(previousChannels.map((channel) => [channel.templateKey, channel]));
  await saveDiscordConfig({
    ...config,
    demoGuildId,
    demoTemplate: snapshot,
    guilds: {
      ...config.guilds,
      [demoGuildId]: {
        guildId: demoGuildId,
        guildName: snapshot.guildName,
        categoryId: snapshot.categories[0]?.sourceCategoryId || "",
        channels: snapshot.channels.map((channel) => ({
          templateKey: channel.templateKey,
          sourceChannelId: channel.sourceChannelId,
          sourceCategoryId: channel.sourceCategoryId,
          channelId: channel.sourceChannelId,
          name: channel.name,
          seededSourceMessageIds: previousByKey.get(channel.templateKey)?.seededSourceMessageIds || [],
        })),
        initializedAt: snapshot.capturedAt,
      },
    },
  }, { repository });
  return snapshot;
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
  selectedTemplateKeys,
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
  const config = await getDiscordConfig({ repository });
  const useDemoTemplate = Boolean(config.demoTemplate?.channels?.length)
    && (Array.isArray(selectedTemplateKeys) || !Array.isArray(selectedTemplateIds));
  if (useDemoTemplate && normalizedGuildId === config.demoGuildId) {
    throw new Error("The Discord Demo server cannot initialize itself.");
  }
  const plan = buildDiscordInitializationPlan(useDemoTemplate
    ? {
        existingChannels: channels,
        template: config.demoTemplate,
        selectedTemplateKeys,
      }
    : { channels, selectedTemplateIds });

  if (useDemoTemplate) {
    if (dryRun) {
      return {
        dryRun: true,
        guild: {
          id: normalizedGuildId,
          name: String(guild?.name || ""),
          categories: plan.categories,
          channels: plan.channels.map((channel) => ({
            templateKey: channel.templateKey,
            channelId: channel.id,
            name: channel.name,
            action: channel.action,
            initialMessageCount: channel.messages.length,
          })),
        },
        plan,
      };
    }

    const targetCategoryBySource = new Map();
    for (const categoryPlan of plan.categories) {
      let categoryId = categoryPlan.id;
      if (categoryPlan.action === "create") {
        const created = await discordRequest(
          `/guilds/${encodeURIComponent(normalizedGuildId)}/channels`,
          {
            ...runtime,
            method: "POST",
            body: {
              name: categoryPlan.name,
              type: 4,
              position: categoryPlan.position,
            },
          },
        );
        categoryId = String(created.id || "");
      }
      targetCategoryBySource.set(categoryPlan.sourceCategoryId, categoryId);
    }

    const previousChannels = Array.isArray(config.guilds?.[normalizedGuildId]?.channels)
      ? config.guilds[normalizedGuildId].channels
      : [];
    const channelsByTemplateKey = new Map(
      previousChannels.map((channel) => [String(channel.templateKey), channel]),
    );
    for (const channelPlan of plan.channels) {
      let channelId = channelPlan.id;
      if (channelPlan.action === "create") {
        const created = await discordRequest(
          `/guilds/${encodeURIComponent(normalizedGuildId)}/channels`,
          {
            ...runtime,
            method: "POST",
            body: {
              name: channelPlan.name,
              type: channelPlan.type,
              parent_id: targetCategoryBySource.get(channelPlan.sourceCategoryId) || null,
              position: channelPlan.position,
              ...(channelPlan.topic ? { topic: channelPlan.topic } : {}),
              nsfw: channelPlan.nsfw,
              rate_limit_per_user: channelPlan.rateLimitPerUser,
            },
          },
        );
        channelId = String(created.id || "");
      }
      const previous = channelsByTemplateKey.get(channelPlan.templateKey);
      channelsByTemplateKey.set(channelPlan.templateKey, {
        templateKey: channelPlan.templateKey,
        sourceChannelId: channelPlan.sourceChannelId,
        sourceCategoryId: channelPlan.sourceCategoryId,
        channelId,
        name: channelPlan.name,
        seededSourceMessageIds: previous?.seededSourceMessageIds || [],
      });
    }

    const saveTargetConfig = async () => saveDiscordConfig({
      ...config,
      guilds: {
        ...config.guilds,
        [normalizedGuildId]: {
          guildId: normalizedGuildId,
          guildName: String(guild?.name || ""),
          categoryId: targetCategoryBySource.values().next().value || "",
          channels: [...channelsByTemplateKey.values()],
          initializedAt: new Date().toISOString(),
        },
      },
    }, { repository });
    let savedConfig = await saveTargetConfig();

    for (const channelPlan of plan.channels) {
      const targetChannel = channelsByTemplateKey.get(channelPlan.templateKey);
      const seeded = new Set(targetChannel.seededSourceMessageIds || []);
      for (const message of channelPlan.messages || []) {
        if (seeded.has(message.sourceMessageId)) continue;
        const content = [message.content, ...(message.attachmentUrls || [])]
          .filter(Boolean)
          .join("\n");
        await sendDiscordMessage(targetChannel.channelId, {
          content,
          embeds: message.embeds,
        }, { ...options, repository });
        seeded.add(message.sourceMessageId);
        targetChannel.seededSourceMessageIds = [...seeded];
        savedConfig = await saveTargetConfig();
      }
    }

    return {
      dryRun: false,
      guild: savedConfig.guilds[normalizedGuildId],
      plan,
      config: savedConfig,
    };
  }

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
  let attachment = normalizedPayload.attachment && typeof normalizedPayload.attachment === "object"
    ? normalizedPayload.attachment
    : null;
  const repository = await resolveRepository(options);
  const runtime = await getRuntimeOptions({ ...options, repository });
  if (imageUrl && !attachment?.data) {
    attachment = await prepareDiscordPosterAttachment(imageUrl, {
      signal: runtime.signal,
      posterFetchImpl: options.posterFetchImpl,
    });
  }
  if (!normalizedChannelId || (!normalizedContent && !embeds.length && !attachment?.data)) {
    throw new Error("Discord channelId and message content are required.");
  }
  const messageBody = {
    ...(normalizedContent ? { content: normalizedContent } : {}),
    ...(embeds.length ? { embeds } : {}),
    allowed_mentions: { parse: [] },
  };
  if (attachment?.data) {
    const formData = new FormData();
    formData.append("payload_json", JSON.stringify(messageBody));
    formData.append(
      "files[0]",
      new Blob([attachment.data], { type: String(attachment.contentType || "application/octet-stream") }),
      String(attachment.filename || "image.png"),
    );
    const sent = await discordRequest(`/channels/${encodeURIComponent(normalizedChannelId)}/messages`, {
      ...runtime,
      method: "POST",
      formData,
    });
    if (!Array.isArray(sent?.attachments) || sent.attachments.length === 0) {
      throw new Error("Discord accepted the message but did not confirm an image attachment.");
    }
    return sent;
  }
  return discordRequest(`/channels/${encodeURIComponent(normalizedChannelId)}/messages`, {
    ...runtime,
    method: "POST",
    body: messageBody,
  });
}

export async function prepareDiscordPosterAttachment(imageUrl, options = {}) {
  const normalizedImageUrl = String(imageUrl || "").trim();
  if (!normalizedImageUrl) throw new Error("Discord poster URL is required.");
  options.signal?.throwIfAborted?.();
  const posterFetchImpl = options.posterFetchImpl || downloadBinary;
  let response;
  try {
    response = await posterFetchImpl(normalizedImageUrl, { signal: options.signal });
  } catch (error) {
    const code = String(error?.cause?.code || error?.code || "").replace(/[^A-Z0-9_-]/gi, "").slice(0, 40);
    throw new Error(`Discord poster download failed${code ? ` (${code})` : ""}: ${error?.message || "unknown error"}`);
  }
  if (!response?.ok) {
    throw new Error(`Discord poster download failed with HTTP ${response?.status || "unknown"}.`);
  }
  const contentType = String(response.headers?.get?.("content-type") || "").split(";", 1)[0].trim().toLowerCase();
  if (!contentType.startsWith("image/")) {
    throw new Error("Discord poster download did not return an image.");
  }
  const data = Buffer.from(await response.arrayBuffer());
  if (!data.length) throw new Error("Discord poster download returned an empty image.");
  const extension = contentType === "image/jpeg" ? "jpg" : contentType.slice("image/".length).replace(/[^a-z0-9]/g, "") || "bin";
  options.signal?.throwIfAborted?.();
  return {
    data,
    filename: `market-card.${extension}`,
    contentType,
  };
}

export async function sendDiscordTestMessage(channelId, content, options = {}) {
  return sendDiscordMessage(channelId, { content }, options);
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Number(limit) || 1), items.length);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }));
  return results;
}

export async function sendDiscordManualPublish({
  channelIds = [],
  content = "",
  imageUrl = "",
  embeds = [],
  attachment = null,
} = {}, options = {}) {
  const targets = [...new Set(
    (Array.isArray(channelIds) ? channelIds : [])
      .map((channelId) => String(channelId || "").trim())
      .filter(Boolean),
  )];
  const baseContent = String(content || "").trim();
  const normalizedImageUrl = String(imageUrl || "").trim();
  const normalizedEmbeds = Array.isArray(embeds) ? embeds : [];

  if (!targets.length) {
    throw new Error("Select at least one Discord channel.");
  }
  if (!baseContent && !normalizedImageUrl && !normalizedEmbeds.length && !attachment?.data) {
    throw new Error("Enter message content, an image URL, or upload an image.");
  }

  const repository = await resolveRepository(options);
  const config = await getDiscordConfig({ repository });
  const guildIdByChannel = new Map(
    Object.entries(config.guilds || {}).flatMap(([guildId, guild]) =>
      (Array.isArray(guild?.channels) ? guild.channels : [])
        .map((channel) => [String(channel?.channelId || "").trim(), String(guildId)])
        .filter(([channelId]) => channelId),
    ),
  );
  const hydratedTargets = await hydrateDestinationCtas(repository, targets.map((channelId) => ({
    platform: "discord",
    guildId: guildIdByChannel.get(channelId) || "",
    channelId,
  })));
  const ctaByChannel = new Map(hydratedTargets.map((target) => [String(target.channelId), target]));
  const runtime = await getRuntimeOptions({ ...options, repository });
  const allowedChannelIds = new Set(
    Object.values(config.guilds || {}).flatMap((guild) =>
      (Array.isArray(guild?.channels) ? guild.channels : [])
        .map((channel) => String(channel?.channelId || "").trim())
        .filter(Boolean),
    ),
  );
  const liveChannelsById = new Map();
  try {
    const health = await checkDiscordHealth({
      ...options,
      repository,
      botToken: runtime.botToken,
      fetchImpl: runtime.fetchImpl,
    });
    for (const channel of (health.guilds || []).flatMap((guild) => guild.channels || [])) {
      const channelId = String(channel.channelId || "");
      liveChannelsById.set(channelId, channel);
      if (channel.canSend) allowedChannelIds.add(channelId);
    }
  } catch {
    // Preserve initialized destinations when Discord's live inspection is temporarily unavailable.
  }
  const results = await mapWithConcurrency(targets, 3, async (channelId) => {
    if (!allowedChannelIds.has(channelId)) {
      return {
        ok: false,
        channelId,
        error: "Discord channel is not an initialized destination.",
      };
    }
    const liveChannel = liveChannelsById.get(channelId);
    // Only treat the capability snapshot as authoritative after a successful
    // live inspection. A failed health check marks cached channels unavailable;
    // the Discord send response remains the source of truth in that case.
    const hasVerifiedLivePermissions = liveChannel?.available === true && liveChannel?.canSend === true;
    if (attachment?.data && hasVerifiedLivePermissions && liveChannel.canAttach === false) {
      return { ok: false, channelId, error: "Discord channel is missing Attach Files permission." };
    }
    if (normalizedImageUrl && hasVerifiedLivePermissions && liveChannel.canAttach === false) {
      return { ok: false, channelId, error: "Discord channel is missing Attach Files permission." };
    }
    if (normalizedEmbeds.length && hasVerifiedLivePermissions && liveChannel.canEmbed === false) {
      return { ok: false, channelId, error: "Discord channel is missing Embed Links permission." };
    }
    try {
      const normalizedContent = composeManualMessage(baseContent, ctaByChannel.get(channelId), { limit: 2000 });
      const sent = await sendDiscordMessage(
        channelId,
        {
          content: normalizedContent,
          imageUrl: normalizedImageUrl,
          embeds: normalizedEmbeds,
          attachment,
        },
        {
          ...options,
          repository,
          botToken: runtime.botToken,
          fetchImpl: runtime.fetchImpl,
        },
      );
      return {
        ok: true,
        channelId,
        messageId: String(sent?.id || ""),
      };
    } catch (error) {
      return {
        ok: false,
        channelId,
        error: sanitizeDiscordError(error?.message, runtime.botToken),
      };
    }
  });

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
  let visibleGuilds = [];
  try {
    const guilds = await discordRequest("/users/@me/guilds", runtime);
    visibleGuilds = Array.isArray(guilds) ? guilds : [];
  } catch {
    visibleGuilds = [];
  }
  const configuredGuilds = Object.values(config.guilds || {});
  const guildSummaries = [...visibleGuilds];
  const visibleGuildIds = new Set(visibleGuilds.map((guild) => String(guild?.id || "")));
  for (const guild of configuredGuilds) {
    if (!visibleGuildIds.has(String(guild?.guildId || ""))) {
      guildSummaries.push({ id: guild?.guildId, name: guild?.guildName });
    }
  }
  const guildResults = await Promise.all(guildSummaries.map(async (guildSummary) => {
    const guildId = String(guildSummary?.id || "");
    const configuredGuild = config.guilds?.[guildId] || {
      guildId,
      guildName: String(guildSummary?.name || ""),
      channels: [],
    };
    try {
      const [liveGuild, liveChannels, roles, member] = await Promise.all([
        discordRequest(`/guilds/${encodeURIComponent(guildId)}`, runtime),
        discordRequest(`/guilds/${encodeURIComponent(guildId)}/channels`, runtime),
        discordRequest(`/guilds/${encodeURIComponent(guildId)}/roles`, runtime),
        discordRequest(`/guilds/${encodeURIComponent(guildId)}/members/${encodeURIComponent(botId)}`, runtime),
      ]);
      const configuredById = new Map(
        (configuredGuild.channels || []).map((channel) => [String(channel.channelId || ""), channel]),
      );
      const guildPermissions = resolveGuildPermissions({ guildId, roles, member });
      const missingPermissions = REQUIRED_PERMISSION_KEYS.filter((key) => guildPermissions[key] !== true);
      const liveTextChannels = (Array.isArray(liveChannels) ? liveChannels : [])
        .filter((channel) => [0, 5].includes(Number(channel?.type)))
        .sort((left, right) => Number(left?.position || 0) - Number(right?.position || 0));
      const channels = liveTextChannels.map((liveChannel) => {
        const channelId = String(liveChannel?.id || "");
        const configuredChannel = configuredById.get(channelId) || {};
        const templateId = Number(configuredChannel.templateId);
        const identity = {
          templateKey: String(configuredChannel.templateKey || (Number.isInteger(templateId) ? `legacy:${templateId}` : `discord:${channelId}`)),
          sourceChannelId: String(configuredChannel.sourceChannelId || ""),
          sourceCategoryId: String(configuredChannel.sourceCategoryId || ""),
          ...(Number.isInteger(templateId) ? { templateId } : {}),
        };
        const permissions = resolveChannelPermissions({
          guildId,
          botId,
          roles,
          member,
          channel: liveChannel,
        });
        const canView = permissions.VIEW_CHANNEL === true;
        return {
          ...identity,
          channelId,
          name: String(liveChannel.name || configuredChannel.name || ""),
          available: true,
          type: Number(liveChannel.type),
          canView,
          canSend: canView && permissions.SEND_MESSAGES === true,
          canEmbed: canView && permissions.EMBED_LINKS === true,
          canAttach: canView && permissions.ATTACH_FILES === true,
          canManageChannels: permissions.MANAGE_CHANNELS === true,
          canReadHistory: canView && permissions.READ_MESSAGE_HISTORY === true,
          // Basic publishing only needs visibility and Send Messages. Image/link
          // capabilities are exposed separately so the UI can explain the exact gap.
          permissionsOk: canView && permissions.SEND_MESSAGES === true,
          canPublishEmbed: canView && permissions.SEND_MESSAGES === true && permissions.EMBED_LINKS === true,
          canUploadImage: canView && permissions.SEND_MESSAGES === true && permissions.ATTACH_FILES === true,
          error: "",
        };
      });
      const liveChannelIds = new Set(liveTextChannels.map((channel) => String(channel?.id || "")));
      for (const configuredChannel of configuredGuild.channels || []) {
        const channelId = String(configuredChannel?.channelId || "");
        if (liveChannelIds.has(channelId)) continue;
        const templateId = Number(configuredChannel.templateId);
        channels.push({
          templateKey: String(configuredChannel.templateKey || (Number.isInteger(templateId) ? `legacy:${templateId}` : `discord:${channelId}`)),
          sourceChannelId: String(configuredChannel.sourceChannelId || ""),
          sourceCategoryId: String(configuredChannel.sourceCategoryId || ""),
          ...(Number.isInteger(templateId) ? { templateId } : {}),
          channelId,
          name: String(configuredChannel.name || ""),
          available: false,
          type: null,
          canView: false,
          canSend: false,
          canEmbed: false,
          canAttach: false,
          canManageChannels: false,
          canReadHistory: false,
          permissionsOk: false,
          error: "Channel no longer exists or is not visible to the Bot.",
        });
      }
      return {
        guildId,
        guildName: String(liveGuild?.name || configuredGuild.guildName || ""),
        available: true,
        permissions: guildPermissions,
        missingPermissions,
        permissionsOk: missingPermissions.length === 0,
        reauthorizeUrl: runtime.appId ? buildDiscordInstallUrl(runtime.appId, { guildId }) : "",
        error: "",
        channels,
      };
    } catch (error) {
      return {
        guildId,
        guildName: String(configuredGuild?.guildName || guildId),
        available: false,
        permissions: Object.fromEntries(REQUIRED_PERMISSION_KEYS.map((key) => [key, false])),
        missingPermissions: [...REQUIRED_PERMISSION_KEYS],
        permissionsOk: false,
        reauthorizeUrl: runtime.appId ? buildDiscordInstallUrl(runtime.appId, { guildId }) : "",
        error: sanitizeDiscordError(error?.message, runtime.botToken),
        channels: (configuredGuild.channels || []).map((channel) => {
          const templateId = Number(channel.templateId);
          return {
            templateKey: String(channel.templateKey || (Number.isInteger(templateId) ? `legacy:${templateId}` : "")),
            sourceChannelId: String(channel.sourceChannelId || ""),
            sourceCategoryId: String(channel.sourceCategoryId || ""),
            ...(Number.isInteger(templateId) ? { templateId } : {}),
            channelId: String(channel.channelId || ""),
            name: String(channel.name || ""),
            available: false,
            type: null,
            canView: false,
            canSend: false,
            canEmbed: false,
            canAttach: false,
            canManageChannels: false,
            canReadHistory: false,
            permissionsOk: false,
            error: "Server permission check failed.",
          };
        }),
      };
    }
  }));

  const allChannels = guildResults.flatMap((guild) => guild.channels);
  const sendableChannels = allChannels.filter((channel) => channel.permissionsOk).length;
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
