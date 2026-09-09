const API_TIMEOUT_MS = 10_000;
const MAX_PAGES = 5;

export function liveProviderStatus(source, env = process.env) {
  if (source?.platform === 'YouTube') return { provider: 'YouTube Live', ready: Boolean(env.YOUTUBE_API_KEY), missing: env.YOUTUBE_API_KEY ? '' : 'YOUTUBE_API_KEY' };
  if (source?.platform === 'X') return { provider: 'X Spaces', ready: Boolean(env.X_BEARER_TOKEN), missing: env.X_BEARER_TOKEN ? '' : 'X_BEARER_TOKEN' };
  return { provider: String(source?.platform || ''), ready: false, missing: 'UNSUPPORTED_LIVE_PLATFORM' };
}

function accountIdentity(source) {
  let url;
  try { url = new URL(source.accountUrl); } catch { throw new Error('直播监控需要有效的账号主页'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('直播账号必须使用平台 HTTPS 主页');
  const host = url.hostname.replace(/^www\./, '').toLowerCase();
  const parts = url.pathname.split('/').filter(Boolean);
  if (source.platform === 'X' && ['x.com', 'twitter.com'].includes(host) && /^[a-zA-Z0-9_]{1,15}$/.test(parts[0] || '') && parts.length === 1) return { username: parts[0] };
  if (source.platform === 'YouTube' && host === 'youtube.com') {
    if (parts[0] === 'channel' && /^UC[a-zA-Z0-9_-]+$/.test(parts[1] || '') && parts.length === 2) return { channelId: parts[1] };
    if (parts[0]?.startsWith('@') && parts.length === 1) return { handle: decodeURIComponent(parts[0]) };
    if (parts[0] === 'user' && parts[1] && parts.length === 2) return { username: parts[1] };
  }
  throw new Error('无法识别直播账号，请使用 X 主页或 YouTube 的 @handle / channel / user 主页');
}

async function apiGet(origin, endpoint, params, { fetchImpl, signal, token, provider }) {
  const url = new URL(endpoint, origin);
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== '') url.searchParams.set(key, value); });
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(url.toString(), { headers: { accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, redirect: 'error', cache: 'no-store', signal: requestSignal });
  } catch { throw new Error(`${provider} 直播接口连接失败或超时`); }
  if (!response.ok) throw new Error(`${provider} 直播接口 HTTP ${response.status}，请检查凭据、额度或平台状态`);
  let body;
  try { body = await response.json(); } catch { throw new Error(`${provider} 直播接口返回了无效数据`); }
  if (body.error || body.errors?.length) throw new Error(`${provider} 直播接口报告错误，未将本次检测视为未开播`);
  return body;
}

async function youtubeFeedIds(channelId, { fetchImpl, signal }) {
  const timeout = AbortSignal.timeout(API_TIMEOUT_MS);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  let response;
  try {
    response = await fetchImpl(`https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(channelId)}`, { headers: { accept: 'application/atom+xml' }, redirect: 'error', cache: 'no-store', signal: requestSignal });
  } catch { throw new Error('YouTube Feed 连接失败或超时'); }
  if (!response.ok) throw new Error(`YouTube Feed HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > 512_000) throw new Error('YouTube Feed 超过读取上限');
  const reader = response.body?.getReader();
  if (!reader) throw new Error('YouTube Feed 内容为空');
  const decoder = new TextDecoder();
  let text = '', bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 512_000) throw new Error('YouTube Feed 超过读取上限');
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
  if (!/<feed\b/i.test(text) || !/<\/feed>\s*$/i.test(text) || /<!DOCTYPE|<!ENTITY/i.test(text)) throw new Error('YouTube Feed 格式无效');
  const firstEntry = text.search(/<entry\b/);
  const header = firstEntry < 0 ? text : text.slice(0, firstEntry);
  const rootChannelId = header.match(/<yt:channelId>\s*([^<]+)\s*<\/yt:channelId>/)?.[1]?.trim();
  // YouTube's feed header can omit UC, while each entry uses the full channel ID.
  if (rootChannelId !== channelId && `UC${rootChannelId}` !== channelId) throw new Error('YouTube Feed 归属校验失败');
  const entries = [...text.matchAll(/<entry\b[^>]*>([\s\S]*?)<\/entry>/g)];
  if (entries.length > 100 || entries.length !== (text.match(/<entry\b/g) || []).length) throw new Error('YouTube Feed 条目格式无效');
  return entries.map(([, entry]) => {
    if (entry.match(/<yt:channelId>\s*([^<]+)\s*<\/yt:channelId>/)?.[1]?.trim() !== channelId) throw new Error('YouTube Feed 条目归属校验失败');
    const id = entry.match(/<yt:videoId>\s*([^<]+)\s*<\/yt:videoId>/)?.[1]?.trim();
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id || '')) throw new Error('YouTube Feed 缺少视频编号');
    return id;
  });
}

async function youtubeUploadIds(channelId, get) {
  const channels = await get('channels', { part: 'contentDetails', id: channelId });
  const channel = channels.items?.[0];
  if (channels.items?.length !== 1 || channel?.id !== channelId) throw new Error('YouTube 视频列表频道归属校验失败');
  const playlistId = channel.contentDetails?.relatedPlaylists?.uploads;
  if (!/^[a-zA-Z0-9_-]+$/.test(playlistId || '')) throw new Error('YouTube 频道视频列表不可用');
  // Bounded candidate discovery, not evidence that any item is live. Scheduled
  // search still reconciles streams absent from this latest-items window.
  const playlist = await get('playlistItems', { part: 'snippet,contentDetails', playlistId, maxResults: '50' });
  if (!Array.isArray(playlist.items) || playlist.items.length > 50) throw new Error('YouTube 视频列表格式无效');
  return playlist.items.map(item => {
    if (item.snippet?.channelId !== channelId) throw new Error('YouTube 视频列表归属校验失败');
    const id = item.contentDetails?.videoId;
    if (!/^[a-zA-Z0-9_-]{11}$/.test(id || '')) throw new Error('YouTube 视频列表缺少视频编号');
    return id;
  });
}

export async function detectSocialLive(source, { env = process.env, fetchImpl = fetch, signal, discovery } = {}) {
  const status = liveProviderStatus(source, env);
  if (!status.ready) throw new Error(`直播检测尚未配置：${status.missing}`);
  const identity = accountIdentity(source);
  if (source.platform === 'X') {
    const options = { fetchImpl, signal, token: env.X_BEARER_TOKEN, provider: 'X Spaces' };
    const profile = await apiGet('https://api.x.com', `/2/users/by/username/${encodeURIComponent(identity.username)}`, {}, options);
    if (!profile.data?.id || String(profile.data.username).toLowerCase() !== identity.username.toLowerCase()) throw new Error('X 直播账号归属校验失败');
    const result = await apiGet('https://api.x.com', '/2/spaces/by/creator_ids', { user_ids: profile.data.id, 'space.fields': 'id,title,state,started_at,scheduled_start,ended_at', expansions: 'creator_id' }, options);
    if (!Array.isArray(result.data) && !(result.data === undefined && result.meta?.result_count === 0)) throw new Error('X Spaces 直播列表格式无效');
    const owned = (result.data || []).filter(item => String(item.creator_id) === String(profile.data.id));
    if (owned.some(item => !['live', 'scheduled', 'ended', 'canceled'].includes(item.state))) throw new Error('X Spaces 返回未知直播状态');
    const broadcasts = owned.filter(item => item.state === 'live' && !item.ended_at).map(item => {
      if (!/^[a-zA-Z0-9]+$/.test(item.id || '') || !item.title) throw new Error('X Spaces 缺少直播编号或标题');
      return { platform: 'X', format: 'Spaces', ownerId: String(profile.data.id), id: item.id, title: String(item.title).slice(0, 300), url: `https://x.com/i/spaces/${item.id}`, startedAt: item.started_at || '', state: 'live' };
    });
    return { provider: status.provider, broadcasts, scheduledCount: owned.filter(item => item.state === 'scheduled').length };
  }
  const options = { fetchImpl, signal, provider: 'YouTube' };
  const get = (endpoint, params) => apiGet('https://www.googleapis.com', `/youtube/v3/${endpoint}`, { key: env.YOUTUBE_API_KEY, ...params }, options);
  let channelId = identity.channelId;
  if (!channelId) {
    const channels = await get('channels', { part: 'id', ...(identity.handle ? { forHandle: identity.handle } : { forUsername: identity.username }) });
    if (channels.items?.length !== 1 || !channels.items[0].id) throw new Error('YouTube 直播账号归属无法确认');
    channelId = channels.items[0].id;
  }
  const ids = new Set((discovery?.knownVideoIds || []).filter(id => /^[a-zA-Z0-9_-]+$/.test(id)).slice(0, 100));
  let feedOk = false, uploadsOk = false, searchOk = false, warning = '';
  if (discovery) {
    try {
      for (const id of await youtubeFeedIds(channelId, options)) ids.add(id);
      feedOk = true;
    } catch (error) {
      try {
        for (const id of await youtubeUploadIds(channelId, get)) ids.add(id);
        uploadsOk = true;
        warning = '频道动态暂不可用，已改用官方视频列表核验；新直播仍可能受平台收录延迟影响。';
      } catch (fallbackError) {
        if (!discovery.search) throw new Error(`${error.message}; ${fallbackError.message}`);
        warning = '频道动态及视频列表暂不可用，本轮使用官方搜索补查；快速检测可能延迟。';
      }
    }
  }
  let pageToken;
  if (!discovery || discovery.search) {
    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        const results = await get('search', { part: 'snippet', channelId, eventType: 'live', type: 'video', maxResults: '50', pageToken });
        if (!Array.isArray(results.items)) throw new Error('YouTube 直播列表格式无效');
        for (const item of results.items) {
          if (!item.id?.videoId) throw new Error('YouTube 直播搜索缺少视频编号');
          ids.add(item.id.videoId);
        }
        if (!results.nextPageToken) { pageToken = null; break; }
        if (results.nextPageToken === pageToken) throw new Error('YouTube 直播列表分页停滞');
        pageToken = results.nextPageToken;
      }
      if (pageToken) throw new Error('YouTube 直播列表超过单次检查上限');
      searchOk = true;
    } catch (error) {
      if (!feedOk && !uploadsOk) throw error;
      warning = '完整搜索补查失败；已继续核验频道动态或官方视频列表和已知直播，未收录的直播可能延迟发现。';
    }
  }
  const broadcasts = [];
  const trackedVideoIds = [];
  let scheduledCount = 0;
  const values = [...ids];
  for (let i = 0; i < values.length; i += 50) {
    const details = await get('videos', { part: 'snippet,liveStreamingDetails', id: values.slice(i, i + 50).join(','), hl: 'en' });
    if (!Array.isArray(details.items)) throw new Error('YouTube 直播详情格式无效');
    for (const item of details.items) {
      if (!ids.has(item.id) || item.snippet?.channelId !== channelId) throw new Error('YouTube 直播归属校验失败');
      const live = item.liveStreamingDetails;
      if (item.snippet?.liveBroadcastContent === 'upcoming' && !live?.actualEndTime) { trackedVideoIds.push(item.id); scheduledCount++; }
      if (item.snippet?.liveBroadcastContent !== 'live' || !live?.actualStartTime || live.actualEndTime) continue;
      if (!Number.isFinite(Date.parse(live.actualStartTime)) || !item.snippet.title || !/^[a-zA-Z0-9_-]+$/.test(item.id)) throw new Error('YouTube 直播详情不完整');
      trackedVideoIds.push(item.id);
      broadcasts.push({ platform: 'YouTube', format: 'Live', ownerId: channelId, id: item.id, title: String(item.snippet.localized?.title || item.snippet.title).slice(0, 300), url: `https://www.youtube.com/watch?v=${item.id}`, startedAt: live.actualStartTime, state: 'live' });
    }
  }
  return { provider: status.provider, broadcasts, scheduledCount, trackedVideoIds, ...(discovery ? { strategy: feedOk ? searchOk ? 'youtube-feed-search-api' : 'youtube-feed-api' : uploadsOk ? searchOk ? 'youtube-uploads-search-api' : 'youtube-uploads-api' : 'youtube-search-api', ...(warning ? { warning } : {}) } : {}) };
}
