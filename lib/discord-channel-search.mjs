function normalizeSearchValue(value) {
  return String(value || "").trim().toLocaleLowerCase();
}

export function filterDiscordGuildChannels(guilds, searchValue) {
  const sourceGuilds = Array.isArray(guilds) ? guilds : [];
  const keyword = normalizeSearchValue(searchValue);
  if (!keyword) return sourceGuilds;

  return sourceGuilds.flatMap((guild) => {
    if (normalizeSearchValue(guild?.guildName).includes(keyword)) return [guild];

    const channels = (Array.isArray(guild?.channels) ? guild.channels : []).filter((channel) => (
      normalizeSearchValue(channel?.name).includes(keyword)
    ));

    return channels.length ? [{ ...guild, channels }] : [];
  });
}
