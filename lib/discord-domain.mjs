const DISCORD_OAUTH_BASE_URL = "https://discord.com/oauth2/authorize";

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

export function normalizeDiscordChannelSelection(selection) {
  const normalized = [...new Set((selection || []).map((item) => Number(item)))]
    .sort((left, right) => left - right);

  if (!normalized.length) {
    throw new Error("At least one Discord channel template must be selected.");
  }

  const validIds = new Set(DISCORD_CHANNEL_TEMPLATES.map((template) => template.id));
  if (normalized.some((id) => !Number.isInteger(id) || !validIds.has(id))) {
    throw new Error("Unknown Discord channel template.");
  }

  return normalized;
}

export function buildDiscordInstallUrl(appId) {
  const normalizedAppId = String(appId || "").trim();
  if (!normalizedAppId) {
    throw new Error("Discord App ID is required.");
  }

  const params = new URLSearchParams({
    client_id: normalizedAppId,
    scope: "bot applications.commands",
    permissions: DISCORD_REQUIRED_PERMISSIONS,
  });
  return `${DISCORD_OAUTH_BASE_URL}?${params.toString()}`;
}

export function buildDiscordInitializationPlan({
  channels = [],
  existingChannels,
  selectedTemplateIds = DISCORD_CHANNEL_TEMPLATES.map((template) => template.id),
} = {}) {
  const availableChannels = Array.isArray(existingChannels) ? existingChannels : channels;
  const selection = normalizeDiscordChannelSelection(selectedTemplateIds);
  const category = availableChannels.find((channel) => (
    Number(channel.type) === 4 && channel.name === DISCORD_CATEGORY_NAME
  ));
  const categoryPlan = category
    ? { action: "reuse", id: String(category.id), name: DISCORD_CATEGORY_NAME }
    : { action: "create", id: null, name: DISCORD_CATEGORY_NAME };

  const channelPlans = selection.map((templateId) => {
    const template = DISCORD_CHANNEL_TEMPLATES.find((item) => item.id === templateId);
    const existing = availableChannels.find((channel) => (
      Number(channel.type) === 0
      && channel.name === template.name
      && (!category || String(channel.parent_id || "") === String(category.id))
    ));

    return {
      action: existing ? "reuse" : "create",
      id: existing ? String(existing.id) : null,
      templateId: template.id,
      name: template.name,
      label: template.label,
      position: template.id - 1,
    };
  });

  return {
    category: categoryPlan,
    channels: channelPlans,
  };
}

export function normalizeDiscordConfig(value = {}) {
  const rawGuilds = value?.guilds && typeof value.guilds === "object" && !Array.isArray(value.guilds)
    ? value.guilds
    : {};
  const guilds = Object.fromEntries(
    Object.entries(rawGuilds)
      .map(([guildId, guild]) => {
        const normalizedGuildId = String(guild?.guildId || guildId || "").trim();
        if (!normalizedGuildId) return null;
        const channels = Array.isArray(guild?.channels)
          ? guild.channels
            .map((channel) => ({
              templateId: Number(channel?.templateId),
              channelId: String(channel?.channelId || "").trim(),
              name: String(channel?.name || "").trim(),
            }))
            .filter((channel) => (
              Number.isInteger(channel.templateId)
              && channel.templateId >= 1
              && channel.templateId <= 7
              && channel.channelId
            ))
            .sort((left, right) => left.templateId - right.templateId)
          : [];
        return [normalizedGuildId, {
          guildId: normalizedGuildId,
          guildName: String(guild?.guildName || "").trim(),
          categoryId: String(guild?.categoryId || "").trim(),
          channels,
          initializedAt: String(guild?.initializedAt || "").trim(),
        }];
      })
      .filter(Boolean),
  );

  const normalized = {
    demoGuildId: String(value?.demoGuildId || "").trim(),
    syncEnabled: value?.syncEnabled === true,
    guilds,
    routes: [],
  };
  normalized.routes = buildDiscordRoutes(normalized);
  return normalized;
}

export function buildDiscordRoutes(value = {}) {
  const demoGuildId = String(value?.demoGuildId || "").trim();
  const guilds = value?.guilds && typeof value.guilds === "object" ? value.guilds : {};
  const demoGuild = guilds[demoGuildId];
  if (!demoGuildId || !demoGuild) return [];

  const sourceByTemplate = new Map(
    (demoGuild.channels || []).map((channel) => [Number(channel.templateId), channel]),
  );

  return Object.values(guilds)
    .filter((guild) => String(guild?.guildId || "") !== demoGuildId)
    .sort((left, right) => String(left.guildId).localeCompare(String(right.guildId)))
    .flatMap((targetGuild) => (targetGuild.channels || [])
      .map((targetChannel) => {
        const sourceChannel = sourceByTemplate.get(Number(targetChannel.templateId));
        if (!sourceChannel) return null;
        return {
          id: `${demoGuildId}:${sourceChannel.channelId}->${targetGuild.guildId}:${targetChannel.channelId}`,
          sourceGuildId: demoGuildId,
          sourceChannelId: String(sourceChannel.channelId),
          targetGuildId: String(targetGuild.guildId),
          targetChannelId: String(targetChannel.channelId),
          templateId: Number(targetChannel.templateId),
          enabled: true,
        };
      })
      .filter(Boolean))
    .sort((left, right) => (
      left.targetGuildId.localeCompare(right.targetGuildId)
      || left.templateId - right.templateId
    ));
}

export function findDiscordRoutesForMessage(config, message, { botId } = {}) {
  const normalized = normalizeDiscordConfig(config);
  const authorIsBot = message?.author?.bot === true;
  const isOwnBot = Boolean(botId) && String(message?.author?.id || "") === String(botId);
  if (
    !normalized.syncEnabled ||
    message?.webhookId ||
    (authorIsBot && !isOwnBot)
  ) {
    return [];
  }
  const guildId = String(message?.guildId || message?.guild?.id || "").trim();
  const channelId = String(message?.channelId || message?.channel?.id || "").trim();
  if (!guildId || !channelId || guildId !== normalized.demoGuildId) return [];
  return normalized.routes.filter((route) => (
    route.enabled
    && route.sourceGuildId === guildId
    && route.sourceChannelId === channelId
  ));
}

export function buildDiscordRelayPayload(message = {}) {
  const content = String(message?.content || "");
  const attachments = message?.attachments;
  const files = attachments && typeof attachments.values === "function"
    ? [...attachments.values()].map((attachment) => String(attachment?.url || "")).filter(Boolean)
    : Array.isArray(attachments)
      ? attachments.map((attachment) => String(attachment?.url || "")).filter(Boolean)
      : [];

  if (!content && !files.length) return null;
  return {
    content: content || undefined,
    files,
    allowedMentions: { parse: [] },
  };
}
