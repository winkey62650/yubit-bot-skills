const DISCORD_OAUTH_BASE_URL = "https://discord.com/oauth2/authorize";

export const DISCORD_DEMO_GUILD_NAME = "TheMoonShow VIP Community";

// Kept only to read historical production records. New Discord initialization
// always uses a live snapshot from DISCORD_DEMO_GUILD_NAME.
export const DISCORD_CATEGORY_NAME = "CryptoGuy Academy";
export const DISCORD_CHANNEL_TEMPLATES = Object.freeze([
  Object.freeze({ id: 1, name: "1-read-first-disclaimer", label: "1. READ FIRST - DISCLAIMER" }),
  Object.freeze({ id: 2, name: "2-cryptoguy-trading-zone", label: "2. CryptoGuy Trading Zone" }),
  Object.freeze({ id: 3, name: "3-market-events", label: "3. Market Events" }),
  Object.freeze({ id: 4, name: "4-market-analysis", label: "4. Market Analysis - Crypto/Stocks/TradFi" }),
  Object.freeze({ id: 5, name: "5-community-signal", label: "5. Community Signal" }),
  Object.freeze({ id: 6, name: "6-smart-money-tracker", label: "6. Smart Money Tracker" }),
  Object.freeze({ id: 7, name: "7-yubit-updates", label: "7. YUBIT Updates" }),
]);

const DISCORD_PERMISSIONS = Object.freeze({
  MANAGE_CHANNELS: 1n << 4n,
  VIEW_CHANNEL: 1n << 10n,
  SEND_MESSAGES: 1n << 11n,
  EMBED_LINKS: 1n << 14n,
  ATTACH_FILES: 1n << 15n,
  READ_MESSAGE_HISTORY: 1n << 16n,
});

export const DISCORD_REQUIRED_PERMISSIONS = Object.values(DISCORD_PERMISSIONS)
  .reduce((total, permission) => total | permission, 0n)
  .toString();

function byPosition(left, right) {
  return Number(left?.position || 0) - Number(right?.position || 0)
    || String(left?.name || "").localeCompare(String(right?.name || ""));
}

function normalizeSnapshotMessage(message = {}) {
  const attachmentList = Array.isArray(message.attachments)
    ? message.attachments
    : message.attachments && typeof message.attachments === "object"
      ? Object.values(message.attachments)
      : [];
  return {
    sourceMessageId: String(message.id || message.sourceMessageId || "").trim(),
    content: String(message.content || ""),
    attachmentUrls: attachmentList
      .map((attachment) => String(attachment?.url || "").trim())
      .filter(Boolean),
    embeds: Array.isArray(message.embeds) ? message.embeds : [],
    createdAt: String(message.timestamp || message.createdAt || "").trim(),
  };
}

export function buildDiscordDemoSnapshot({
  guild,
  channels = [],
  messagesByChannel = {},
  messageStatusByChannel = {},
  capturedAt,
} = {}) {
  const guildId = String(guild?.id || "").trim();
  const guildName = String(guild?.name || "").trim();
  if (!guildId || !guildName) {
    throw new Error("Discord Demo Server must have a valid id and name.");
  }

  const categories = channels
    .filter((channel) => Number(channel?.type) === 4)
    .sort(byPosition)
    .map((category) => ({
      templateKey: `category:${category.id}`,
      sourceCategoryId: String(category.id),
      name: String(category.name || ""),
      position: Number(category.position || 0),
    }));
  const categoryOrder = new Map(categories.map((category, index) => [category.sourceCategoryId, index]));
  const textChannels = channels
    .filter((channel) => [0, 5].includes(Number(channel?.type)))
    .sort((left, right) => (
      (categoryOrder.get(String(left.parent_id || "")) ?? Number.MAX_SAFE_INTEGER)
      - (categoryOrder.get(String(right.parent_id || "")) ?? Number.MAX_SAFE_INTEGER)
      || byPosition(left, right)
    ))
    .map((channel) => {
      const messageStatus = messageStatusByChannel[String(channel.id)] || {};
      const contentReadStatus = messageStatus.status === "unavailable" ? "unavailable" : "ok";
      return {
        templateKey: `discord:${channel.id}`,
        sourceChannelId: String(channel.id),
        sourceCategoryId: String(channel.parent_id || ""),
        name: String(channel.name || ""),
        type: Number(channel.type),
        position: Number(channel.position || 0),
        topic: String(channel.topic || ""),
        nsfw: channel.nsfw === true,
        rateLimitPerUser: Number(channel.rate_limit_per_user || 0),
        contentReadStatus,
        contentReadError: contentReadStatus === "unavailable" ? String(messageStatus.error || "") : "",
        messages: (messagesByChannel[String(channel.id)] || [])
          .map(normalizeSnapshotMessage)
          .filter((message) => message.sourceMessageId && (message.content || message.attachmentUrls.length || message.embeds.length))
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.sourceMessageId.localeCompare(right.sourceMessageId)),
      };
    });

  return {
    guildId,
    guildName,
    capturedAt: String(capturedAt || new Date().toISOString()),
    categories,
    channels: textChannels,
    unavailableContentChannelCount: textChannels.filter((channel) => channel.contentReadStatus === "unavailable").length,
  };
}

export function normalizeDiscordChannelSelection(selection, template) {
  if (template?.channels) {
    const requested = new Set((selection || []).map((item) => String(item || "").trim()).filter(Boolean));
    if (!requested.size) throw new Error("At least one Discord channel template must be selected.");
    const ordered = template.channels.map((channel) => String(channel.templateKey || "")).filter((key) => requested.has(key));
    if (ordered.length !== requested.size) throw new Error("Unknown Discord channel template.");
    return ordered;
  }

  const normalized = [...new Set((selection || []).map((item) => Number(item)))].sort((a, b) => a - b);
  if (!normalized.length) throw new Error("At least one Discord channel template must be selected.");
  const validIds = new Set(DISCORD_CHANNEL_TEMPLATES.map((templateItem) => templateItem.id));
  if (normalized.some((id) => !Number.isInteger(id) || !validIds.has(id))) {
    throw new Error("Unknown Discord channel template.");
  }
  return normalized;
}

export function buildDiscordInstallUrl(appId, { guildId } = {}) {
  const normalizedAppId = String(appId || "").trim();
  if (!normalizedAppId) throw new Error("Discord App ID is required.");
  const params = new URLSearchParams({ client_id: normalizedAppId, scope: "bot applications.commands", permissions: DISCORD_REQUIRED_PERMISSIONS });
  const normalizedGuildId = String(guildId || "").trim();
  if (normalizedGuildId) {
    params.set("guild_id", normalizedGuildId);
    params.set("disable_guild_select", "true");
  }
  return `${DISCORD_OAUTH_BASE_URL}?${params.toString()}`;
}

export function buildDiscordInitializationPlan({ channels = [], existingChannels, template, selectedTemplateKeys, selectedTemplateIds } = {}) {
  const availableChannels = Array.isArray(existingChannels) ? existingChannels : channels;
  if (template?.channels) {
    const selection = normalizeDiscordChannelSelection(selectedTemplateKeys || template.channels.map((channel) => channel.templateKey), template);
    const selectedChannels = template.channels.filter((channel) => selection.includes(channel.templateKey));
    const requiredCategoryIds = new Set(selectedChannels.map((channel) => channel.sourceCategoryId).filter(Boolean));
    const categories = (template.categories || []).filter((category) => requiredCategoryIds.has(category.sourceCategoryId)).map((category) => {
      const existing = availableChannels.find((channel) => Number(channel.type) === 4 && channel.name === category.name);
      return { ...category, action: existing ? "reuse" : "create", id: existing ? String(existing.id) : null };
    });
    const categoryIdBySource = new Map(categories.map((category) => [category.sourceCategoryId, category.id]));
    const plannedChannels = selectedChannels.map((channel) => {
      const parentId = categoryIdBySource.get(channel.sourceCategoryId) || null;
      const existing = availableChannels.find((candidate) => [0, 5].includes(Number(candidate.type))
        && candidate.name === channel.name
        && (channel.sourceCategoryId
          ? Boolean(parentId) && String(candidate.parent_id || "") === String(parentId)
          : !candidate.parent_id));
      return { ...channel, action: existing ? "reuse" : "create", id: existing ? String(existing.id) : null };
    });
    return { categories, channels: plannedChannels };
  }

  const selection = normalizeDiscordChannelSelection(selectedTemplateIds || DISCORD_CHANNEL_TEMPLATES.map((item) => item.id));
  const category = availableChannels.find((channel) => Number(channel.type) === 4 && channel.name === DISCORD_CATEGORY_NAME);
  const categoryPlan = category ? { action: "reuse", id: String(category.id), name: DISCORD_CATEGORY_NAME } : { action: "create", id: null, name: DISCORD_CATEGORY_NAME };
  return {
    category: categoryPlan,
    channels: selection.map((templateId) => {
      const legacy = DISCORD_CHANNEL_TEMPLATES.find((item) => item.id === templateId);
      const existing = availableChannels.find((channel) => Number(channel.type) === 0 && channel.name === legacy.name && (!category || String(channel.parent_id || "") === String(category.id)));
      return { action: existing ? "reuse" : "create", id: existing ? String(existing.id) : null, templateId: legacy.id, name: legacy.name, label: legacy.label, position: legacy.id - 1 };
    }),
  };
}

function normalizeStoredChannel(channel = {}) {
  const templateId = Number(channel.templateId);
  const templateKey = String(channel.templateKey || (Number.isInteger(templateId) ? `legacy:${templateId}` : "")).trim();
  const channelId = String(channel.channelId || "").trim();
  if (!templateKey || !channelId) return null;
  return {
    ...(Number.isInteger(templateId) ? { templateId } : {}),
    templateKey,
    sourceChannelId: String(channel.sourceChannelId || "").trim(),
    sourceCategoryId: String(channel.sourceCategoryId || "").trim(),
    channelId,
    name: String(channel.name || "").trim(),
    seededSourceMessageIds: [...new Set((channel.seededSourceMessageIds || []).map(String).filter(Boolean))],
  };
}

export function normalizeDiscordConfig(value = {}) {
  const rawGuilds = value?.guilds && typeof value.guilds === "object" && !Array.isArray(value.guilds) ? value.guilds : {};
  const guilds = Object.fromEntries(Object.entries(rawGuilds).map(([guildId, guild]) => {
    const normalizedGuildId = String(guild?.guildId || guildId || "").trim();
    if (!normalizedGuildId) return null;
    const channels = (Array.isArray(guild?.channels) ? guild.channels : []).map(normalizeStoredChannel).filter(Boolean);
    return [normalizedGuildId, {
      guildId: normalizedGuildId,
      guildName: String(guild?.guildName || "").trim(),
      categoryId: String(guild?.categoryId || "").trim(),
      channels,
      initializedAt: String(guild?.initializedAt || "").trim(),
    }];
  }).filter(Boolean));
  const normalized = {
    demoGuildId: String(value?.demoGuildId || "").trim(),
    syncEnabled: value?.syncEnabled === true,
    guilds,
    routes: [],
  };
  if (value?.demoTemplate && typeof value.demoTemplate === "object") {
    normalized.demoTemplate = structuredClone(value.demoTemplate);
  }
  normalized.routes = buildDiscordRoutes(normalized);
  return normalized;
}

export function buildDiscordRoutes(value = {}) {
  const demoGuildId = String(value?.demoGuildId || "").trim();
  const guilds = value?.guilds && typeof value.guilds === "object" ? value.guilds : {};
  const demoGuild = guilds[demoGuildId];
  if (!demoGuildId || !demoGuild) return [];
  const sourceByTemplate = new Map((demoGuild.channels || []).map((channel) => [String(channel.templateKey || `legacy:${channel.templateId}`), channel]));
  return Object.values(guilds).filter((guild) => String(guild?.guildId || "") !== demoGuildId).sort((a, b) => String(a.guildId).localeCompare(String(b.guildId))).flatMap((targetGuild) => (targetGuild.channels || []).map((targetChannel) => {
    const templateKey = String(targetChannel.templateKey || `legacy:${targetChannel.templateId}`);
    const sourceChannel = sourceByTemplate.get(templateKey);
    if (!sourceChannel) return null;
    return {
      id: `${demoGuildId}:${sourceChannel.channelId}->${targetGuild.guildId}:${targetChannel.channelId}`,
      sourceGuildId: demoGuildId,
      sourceChannelId: String(sourceChannel.channelId),
      targetGuildId: String(targetGuild.guildId),
      targetChannelId: String(targetChannel.channelId),
      templateKey,
      ...(Number.isInteger(Number(targetChannel.templateId)) ? { templateId: Number(targetChannel.templateId) } : {}),
      enabled: true,
    };
  }).filter(Boolean)).sort((a, b) => a.targetGuildId.localeCompare(b.targetGuildId) || a.templateKey.localeCompare(b.templateKey));
}

export function findDiscordRoutesForMessage(config, message, { botId } = {}) {
  const normalized = normalizeDiscordConfig(config);
  const authorIsBot = message?.author?.bot === true;
  const isOwnBot = Boolean(botId) && String(message?.author?.id || "") === String(botId);
  if (!normalized.syncEnabled || message?.webhookId || (authorIsBot && !isOwnBot)) return [];
  const guildId = String(message?.guildId || message?.guild?.id || "").trim();
  const channelId = String(message?.channelId || message?.channel?.id || "").trim();
  if (!guildId || !channelId || guildId !== normalized.demoGuildId) return [];
  return normalized.routes.filter((route) => route.enabled && route.sourceGuildId === guildId && route.sourceChannelId === channelId);
}

export function buildDiscordRelayPayload(message = {}) {
  const content = String(message?.content || "");
  const attachments = message?.attachments;
  const files = attachments && typeof attachments.values === "function"
    ? [...attachments.values()].map((attachment) => String(attachment?.url || "")).filter(Boolean)
    : Array.isArray(attachments) ? attachments.map((attachment) => String(attachment?.url || "")).filter(Boolean) : [];
  if (!content && !files.length) return null;
  return { content: content || undefined, files, allowedMentions: { parse: [] } };
}
