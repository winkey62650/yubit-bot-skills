export function extractDistributionOverview(payload = {}) {
  const candidate = Array.isArray(payload?.rules)
    ? payload
    : Array.isArray(payload?.overview?.rules)
      ? payload.overview
      : Array.isArray(payload?.result?.overview?.rules)
        ? payload.result.overview
        : {};

  return {
    ...candidate,
    rules: Array.isArray(candidate.rules) ? candidate.rules : [],
  };
}

export function buildDiscordSocialTargetOptions(guilds = []) {
  return (Array.isArray(guilds) ? guilds : []).flatMap((guild) =>
    (Array.isArray(guild.channels) ? guild.channels : [])
      .filter((channel) => Boolean(channel.permissionsOk) && channel.canEmbed !== false)
      .map((channel) => ({
        key: `discord:${guild.guildId}:${channel.channelId}`,
        label: `${guild.guildName} / #${channel.name}`,
        target: {
          platform: "discord",
          guildId: guild.guildId,
          channelId: channel.channelId,
          groupName: guild.guildName,
          channelName: channel.name,
          topicName: channel.name,
          enabled: true,
        },
      })),
  );
}
