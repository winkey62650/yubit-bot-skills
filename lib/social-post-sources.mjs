import { parseXReaderTimeline } from './social-sources.mjs';

export async function fetchSocialPosts(source, { env = process.env, fetchImpl = fetch, signal } = {}) {
  const account = new URL(source.accountUrl);
  if (!['https:', 'http:'].includes(account.protocol) || account.username || account.password) throw new Error('无效账号主页');
  const host = account.hostname.replace(/^www\./, '').toLowerCase();
  const parts = account.pathname.split('/').filter(Boolean);
  const request = async (url, json = true, headers = {}) => {
    const timeout = AbortSignal.timeout(12_000);
    let response;
    try { response = await fetchImpl(url, { headers, cache: 'no-store', redirect: 'error', signal: signal ? AbortSignal.any([signal, timeout]) : timeout }); }
    catch { throw new Error('社媒接口连接失败或超时'); }
    if (!response.ok) throw new Error(`社媒接口 HTTP ${response.status}`);
    if (json) return response.json();
    const text = await response.text();
    if (text.length > 3_000_000) throw new Error('公开时间线超过读取上限');
    return text;
  };
  if (source.platform === 'YouTube') {
    if (host !== 'youtube.com' || !env.YOUTUBE_API_KEY) throw new Error('YouTube 账号或 API Key 未配置');
    const identity = parts[0] === 'channel' && /^UC[\w-]+$/.test(parts[1] || '') && parts.length === 2 ? { id: parts[1] }
      : parts[0]?.startsWith('@') && parts.length === 1 ? { forHandle: decodeURIComponent(parts[0]) } : null;
    if (!identity) throw new Error('请使用 YouTube channel 或 @handle 主页');
    const get = (endpoint, params) => request(`https://www.googleapis.com/youtube/v3/${endpoint}?${new URLSearchParams({ key: env.YOUTUBE_API_KEY, ...params })}`);
    const channels = await get('channels', { part: 'contentDetails', ...identity });
    const channel = channels.items?.[0];
    if (channels.items?.length !== 1 || !channel?.id || (identity.id && channel.id !== identity.id)) throw new Error('YouTube 频道归属校验失败');
    const uploads = channel.contentDetails?.relatedPlaylists?.uploads;
    if (!/^[\w-]+$/.test(uploads || '')) throw new Error('YouTube 视频列表不可用');
    const list = await get('playlistItems', { part: 'snippet,contentDetails', playlistId: uploads, maxResults: '50' });
    if (!Array.isArray(list.items) || list.items.length > 50) throw new Error('YouTube 视频列表格式无效');
    const ids = list.items.map(item => {
      if (item.snippet?.channelId !== channel.id || !/^[\w-]{11}$/.test(item.contentDetails?.videoId || '')) throw new Error('YouTube 视频归属或编号校验失败');
      return item.contentDetails.videoId;
    });
    if (!ids.length) return { ownerId: channel.id, posts: [], strategy: 'youtube-uploads-api', excludedLiveCount: 0 };
    const videos = await get('videos', { part: 'snippet,liveStreamingDetails', id: ids.join(','), hl: 'en' });
    if (!Array.isArray(videos.items)) throw new Error('YouTube 视频详情格式无效');
    let excludedLiveCount = 0;
    const posts = videos.items.flatMap(item => {
      if (!ids.includes(item.id) || item.snippet?.channelId !== channel.id) throw new Error('YouTube 视频归属校验失败');
      if (item.liveStreamingDetails || item.snippet.liveBroadcastContent !== 'none') { excludedLiveCount++; return []; }
      if (!item.snippet.title || !Number.isFinite(Date.parse(item.snippet.publishedAt))) throw new Error('YouTube 视频元数据不完整');
      return [{ platform: 'YouTube', ownerId: channel.id, id: item.id, title: item.snippet.localized?.title || item.snippet.title, publishedAt: item.snippet.publishedAt, url: `https://www.youtube.com/watch?v=${item.id}` }];
    });
    return { ownerId: channel.id, posts, excludedLiveCount, strategy: 'youtube-uploads-api' };
  }
  if (source.platform !== 'X' || !['x.com', 'twitter.com'].includes(host) || parts.length !== 1 || !/^[A-Za-z0-9_]{1,15}$/.test(parts[0])) throw new Error('请使用有效的 X 账号主页');
  const username = parts[0], ownerId = username.toLowerCase();
  const normalize = item => ({ platform: 'X', ownerId, id: String(item.id || item.externalId), title: item.text || item.title, publishedAt: item.created_at || item.publishedAt, url: `https://x.com/${username}/status/${item.id || item.externalId}` });
  if (env.X_BEARER_TOKEN) {
    try {
      const headers = { authorization: `Bearer ${env.X_BEARER_TOKEN}`, accept: 'application/json' };
      const profile = await request(`https://api.x.com/2/users/by/username/${username}`, true, headers);
      if (!profile.data?.id || profile.data.username?.toLowerCase() !== ownerId) throw new Error('X 账号归属校验失败');
      const timeline = await request(`https://api.x.com/2/users/${profile.data.id}/tweets?max_results=100&exclude=retweets,replies&tweet.fields=created_at,author_id,referenced_tweets`, true, headers);
      if (!Array.isArray(timeline.data) && timeline.meta?.result_count !== 0) throw new Error('X 时间线不可用');
      const posts = (timeline.data || []).filter(p => !p.referenced_tweets?.some(r => ['retweeted', 'replied_to'].includes(r.type))).map(p => {
        if (p.author_id !== profile.data.id || !/^\d+$/.test(p.id) || !p.text || !Number.isFinite(Date.parse(p.created_at))) throw new Error('X 推文归属或元数据校验失败');
        return normalize(p);
      });
      return { ownerId, posts, strategy: 'x-api', ...(timeline.meta?.next_token ? { warning: '仅检查平台当前返回的最近 100 条原创推文，较早内容可能未收录。' } : {}) };
    } catch { /* Public reads carry no API credential and still verify ownership. */ }
  }
  for (const host of ['x.com', 'mobile.twitter.com']) {
    try {
      const text = await request(`https://r.jina.ai/https://${host}/${username}`, false, { accept: 'text/plain' });
      const seen = new Set();
      const posts = parseXReaderTimeline(text, username, { all: true })
        .filter(p => !/^\s*(?:@|RT\s+@)/i.test(p.title) && !seen.has(p.externalId) && seen.add(p.externalId)).map(normalize);
      return { ownerId, posts, strategy: 'x-reader-fallback', warning: 'X 官方时间线不可用，当前同步公开页面可读取的原创推文；平台缓存可能延迟或遗漏。' };
    } catch { /* Try the other existing public timeline surface. */ }
  }
  throw new Error('X 公开时间线暂不可读，未发布任何替代内容');
}

export function renderPostNotice(source, post) {
  const label = (value, fallback, limit) => {
    const text = String(value || '').replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!text || (text.match(/\p{L}/gu) || []).some(c => !/\p{Script=Latin}/u.test(c))) return fallback;
    return text.replace(/https?:\/\/\S+/gi, '').replace(/@/g, '＠').replace(/[\\`*_~|<>\[\]()]/g, '').slice(0, limit);
  };
  const youtube = post.platform === 'YouTube';
  if (!(youtube ? /^[\w-]{11}$/ : /^\d+$/).test(post.id)) throw new Error('Invalid content ID');
  const url = youtube ? `https://www.youtube.com/watch?v=${post.id}` : `https://x.com/${post.ownerId}/status/${post.id}`;
  return { content: `**${youtube ? 'NEW VIDEO' : 'NEW POST'} · ${label(source.agent, 'Creator update', 100)}**`, embeds: [{ title: label(post.title, youtube ? 'New YouTube video' : 'New post on X', 250), url, description: `[${youtube ? 'Watch on YouTube' : 'Read on X'}](${url})`, color: 0x315b49, ...(Number.isFinite(Date.parse(post.publishedAt)) ? { timestamp: new Date(post.publishedAt).toISOString() } : {}), footer: { text: `${youtube ? 'YouTube' : 'X'} · Creator update` } }] };
}
