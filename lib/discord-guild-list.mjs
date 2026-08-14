function normalizeGuild(guild, source) {
  const guildId = String(guild?.guildId || guild?.id || "").trim();
  if (!guildId) return null;

  return {
    ...guild,
    guildId,
    guildName: String(guild?.guildName || guild?.name || guildId),
    channels: Array.isArray(guild?.channels)
      ? guild.channels.map((channel) => {
        const name = channel?.name ?? channel?.channelName;
        return {
          ...channel,
          channelId: String(channel?.channelId || channel?.id || ""),
          ...(name == null ? {} : { name: String(name) }),
        };
      }).filter((channel) => channel.channelId)
      : [],
    source,
  };
}

export function mergeDiscordGuilds({
  healthGuilds = [],
  discoveredGuilds = [],
  configuredGuilds = [],
  discoveryAuthoritative = false,
} = {}) {
  const merged = new Map();

  const discoveredIds = new Set(
    (Array.isArray(discoveredGuilds) ? discoveredGuilds : [])
      .map((guild) => String(guild?.guildId || guild?.id || "").trim())
      .filter(Boolean),
  );
  const liveHealthIds = new Set(
    (Array.isArray(healthGuilds) ? healthGuilds : [])
      .filter((guild) => guild?.available !== false)
      .map((guild) => String(guild?.guildId || guild?.id || "").trim())
      .filter(Boolean),
  );
  const liveIds = new Set([...discoveredIds, ...liveHealthIds]);
  const visibleConfiguredGuilds = discoveryAuthoritative
    ? (Array.isArray(configuredGuilds) ? configuredGuilds : []).filter((guild) =>
        liveIds.has(String(guild?.guildId || guild?.id || "").trim()),
      )
    : configuredGuilds;
  const visibleHealthGuilds = discoveryAuthoritative
    ? (Array.isArray(healthGuilds) ? healthGuilds : []).filter(
        (guild) => guild?.available !== false,
      )
    : healthGuilds;

  for (const [source, guilds] of [
    ["configured", visibleConfiguredGuilds],
    ["discovered", discoveredGuilds],
    ["health", visibleHealthGuilds],
  ]) {
    for (const candidate of Array.isArray(guilds) ? guilds : []) {
      const guild = normalizeGuild(candidate, source);
      if (!guild) continue;
      const previous = merged.get(guild.guildId);
      merged.set(guild.guildId, {
        ...(previous || {}),
        ...guild,
        guildName: guild.guildName || previous?.guildName || guild.guildId,
        // A transient Discord health failure may return an empty channel list.
        // Keep the last discovered/configured list instead of turning the UI into 0/0.
        channels: guild.channels.length ? guild.channels : previous?.channels || [],
      });
    }
  }

  return [...merged.values()].sort((a, b) => a.guildName.localeCompare(b.guildName));
}
