function normalizeGuild(guild, source) {
  const guildId = String(guild?.guildId || guild?.id || "").trim();
  if (!guildId) return null;

  return {
    ...guild,
    guildId,
    guildName: String(guild?.guildName || guild?.name || guildId),
    channels: Array.isArray(guild?.channels) ? guild.channels : [],
    source,
  };
}

export function mergeDiscordGuilds({ healthGuilds = [], discoveredGuilds = [], configuredGuilds = [] } = {}) {
  const merged = new Map();

  for (const [source, guilds] of [
    ["configured", configuredGuilds],
    ["discovered", discoveredGuilds],
    ["health", healthGuilds],
  ]) {
    for (const candidate of Array.isArray(guilds) ? guilds : []) {
      const guild = normalizeGuild(candidate, source);
      if (!guild) continue;
      const previous = merged.get(guild.guildId);
      merged.set(guild.guildId, {
        ...(previous || {}),
        ...guild,
        guildName: guild.guildName || previous?.guildName || guild.guildId,
        channels: source === "health" || guild.channels.length ? guild.channels : previous?.channels || [],
      });
    }
  }

  return [...merged.values()].sort((a, b) => a.guildName.localeCompare(b.guildName));
}
