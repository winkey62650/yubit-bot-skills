import test from 'node:test';
import assert from 'node:assert/strict';
import { detectSocialLive } from '../lib/social-live-sources.mjs';

const source = { platform: 'YouTube', accountUrl: 'https://youtube.com/channel/UC123' };
const json = data => new Response(JSON.stringify(data));
const feed = ids => new Response(`<feed xmlns="http://www.w3.org/2005/Atom" xmlns:yt="http://www.youtube.com/xml/schemas/2015"><yt:channelId>UC123</yt:channelId>${ids.map(id => `<entry><yt:videoId>${id}</yt:videoId><yt:channelId>UC123</yt:channelId></entry>`).join('')}</feed>`);
const video = (id, state = 'live') => ({ id, snippet: { channelId: 'UC123', title: 'Market live', liveBroadcastContent: state }, liveStreamingDetails: state === 'upcoming' ? { scheduledStartTime: '2026-09-09T08:00:00Z' } : { actualStartTime: '2026-09-08T08:00:00Z', ...(state === 'none' ? { actualEndTime: '2026-09-08T09:00:00Z' } : {}) } });

test('fast discovery verifies every feed candidate with the API without consuming search quota', async () => {
  const calls = [];
  const result = await detectSocialLive(source, { env: { YOUTUBE_API_KEY: 'secret' }, discovery: { search: false }, fetchImpl: async (url, init) => {
    const u = new URL(url); calls.push(u.pathname);
    if (u.pathname.includes('/feeds/')) { assert.equal(u.searchParams.has('key'), false); assert.equal(init.headers.authorization, undefined); return feed(['live0000001', 'plan0000001', 'ended000001']); }
    assert.ok(u.pathname.endsWith('/videos')); return json({ items: [video('live0000001'), video('plan0000001', 'upcoming'), video('ended000001', 'none')] });
  } });
  assert.deepEqual(result.broadcasts.map(v => v.id), ['live0000001']);
  assert.deepEqual(result.trackedVideoIds, ['live0000001', 'plan0000001']);
  assert.equal(result.scheduledCount, 1);
  assert.equal(calls.some(p => p.endsWith('/search')), false);
});

test('a long-running or scheduled stream remains tracked after leaving the feed', async () => {
  const result = await detectSocialLive(source, { env: { YOUTUBE_API_KEY: 'key' }, discovery: { search: false, knownVideoIds: ['older000001'] }, fetchImpl: async url => {
    const u = new URL(url); if (u.pathname.includes('/feeds/')) return feed([]);
    assert.equal(u.searchParams.get('id'), 'older000001'); return json({ items: [video('older000001')] });
  } });
  assert.equal(result.broadcasts[0].id, 'older000001');
});

test('an unavailable or wrong-owner feed fails closed between budgeted searches', async () => {
  for (const response of [new Response('blocked', { status: 403 }), new Response('<feed><yt:channelId>OTHER</yt:channelId></feed>')]) {
    await assert.rejects(detectSocialLive(source, { env: { YOUTUBE_API_KEY: 'key' }, discovery: { search: false }, fetchImpl: async () => response }), /Feed|归属/);
  }
});

test('budgeted search recovers from feed failure, while search outage does not discard verified feed results', async () => {
  for (const feedFails of [true, false]) {
    const result = await detectSocialLive(source, { env: { YOUTUBE_API_KEY: 'key' }, discovery: { search: true }, fetchImpl: async url => {
      if (url.includes('/feeds/')) return feedFails ? new Response('blocked', { status: 403 }) : feed(['live0000001']);
      if (url.includes('/search')) return feedFails ? json({ items: [{ id: { videoId: 'live0000001' } }] }) : new Response('quota', { status: 403 });
      return json({ items: [video('live0000001')] });
    } });
    assert.equal(result.broadcasts[0].id, 'live0000001'); assert.ok(result.warning);
  }
});

test('a feed entry never proves live status or ownership on its own', async () => {
  await assert.rejects(detectSocialLive(source, { env: { YOUTUBE_API_KEY: 'key' }, discovery: { search: false }, fetchImpl: async url => url.includes('/feeds/') ? feed(['live0000001']) : json({ items: [{ ...video('live0000001'), snippet: { ...video('live0000001').snippet, channelId: 'OTHER' } }] }) }), /归属/);
});
