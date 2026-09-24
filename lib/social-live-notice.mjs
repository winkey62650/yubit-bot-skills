// Platform metadata is data, not Discord markdown or mention syntax.
function label(value, fallback, limit) {
  const text = String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  // Never leak a non-Latin title into the English notification template.
  const letters = text.match(/\p{L}/gu) || [];
  if (!text || letters.some(letter => !/\p{Script=Latin}/u.test(letter))) return fallback;
  return text.replace(/https?:\/\/\S+/gi, '').replace(/@/g, '＠').replace(/[\\`*_~|<>\[\]()]/g, '').slice(0, limit);
}

function details(source, live) {
  const youtube = live.platform === 'YouTube';
  const platform = youtube ? 'YouTube' : 'X Spaces';
  if (!/^[a-zA-Z0-9_-]+$/.test(live.id || '')) throw new Error('Invalid livestream ID');
  const url = youtube ? `https://www.youtube.com/watch?v=${live.id}` : `https://x.com/i/spaces/${live.id}`;
  const startedAt = Number.isFinite(Date.parse(live.startedAt)) ? new Date(live.startedAt).toISOString().replace('.000Z', 'Z') : null;
  return { platform, url, startedAt, creator: label(source.agent, 'The creator', 100), title: label(live.title, `${platform} livestream`, 256) };
}

export function renderSocialLiveNotice(source, live, _now) {
  const d = details(source, live);
  const date = d.startedAt ? formatDate(new Date(d.startedAt)) : 'Live now';
  return [`${d.creator} | ${d.platform}`, `🔴 LIVE NOW · ${date}`, d.title, d.startedAt ? `Started: ${d.startedAt.replace('T', ' ').slice(0, 16)} UTC` : '', `Click here to watch live 👉 ${d.url}`].filter(Boolean).join('\n\n');
}

export function renderDiscordLiveNotice(source, live, _now, { historical = false } = {}) {
  const d = details(source, live);
  return {
    content: [`**${d.creator} | ${d.platform}**`, `🔴 **${historical ? 'LIVESTREAM' : 'LIVE NOW'} · ${d.startedAt ? formatDate(new Date(d.startedAt)) : 'Live now'}**`, d.title, `Click here to watch ${historical ? 'the stream' : 'live'} 👉 ${d.url}`, '@everyone'].join('\n\n'),
    allowedMentions: { parse: [] },
    embeds: [{
      title: d.title,
      url: d.url,
      color: 0xED4245,
      description: `[${historical ? 'Watch on' : d.platform === 'YouTube' ? 'Watch live on' : 'Join live on'} ${d.platform}](${d.url})`,
      ...(d.platform === 'YouTube' ? { image: { url: `https://i.ytimg.com/vi/${live.id}/hqdefault.jpg` } } : {}),
      ...(d.startedAt ? { fields: [{ name: 'Started', value: `<t:${Math.floor(Date.parse(d.startedAt) / 1000)}:f>`, inline: true }], timestamp: d.startedAt } : {}),
      footer: { text: `${d.platform} · ${historical ? 'Stream notification' : 'Livestream alert'}` }
    }]
  };
}

function formatDate(date) {
  const day = date.getUTCDate();
  const suffix = day % 10 === 1 && day !== 11 ? 'st' : day % 10 === 2 && day !== 12 ? 'nd' : day % 10 === 3 && day !== 13 ? 'rd' : 'th';
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(date);
  const month = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' }).format(date);
  return `${weekday} ${day}${suffix} ${month}`;
}
