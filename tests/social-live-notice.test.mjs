import test from 'node:test';
import assert from 'node:assert/strict';
import { renderSocialLiveNotice, renderDiscordLiveNotice } from '../lib/social-live-notice.mjs';
const source = { agent: 'Average Joe Crypto' };
const live = { platform: 'YouTube', id: 'xrBzglllmb8', ownerId: 'UC123', title: 'BITCOIN GOLDEN CROSS', url: 'https://www.youtube.com/watch?v=xrBzglllmb8', startedAt: '2026-09-08T13:01:43Z' };

test('English alerts use actual start time rather than disguising discovery delay as the start', () => {
  const text = renderSocialLiveNotice(source, live, '2026-09-08T13:38:04Z');
  assert.match(text, /LIVE NOW/); assert.match(text, /Started: 2026-09-08 13:01 UTC/); assert.doesNotMatch(text, /13:38|[\u3400-\u9fff]/);
  const payload = renderDiscordLiveNotice(source, live, '2026-09-08T13:38:04Z');
  assert.equal(payload.embeds.length, 1); assert.equal(payload.embeds[0].url, live.url);
  assert.match(payload.embeds[0].description, /Watch live on YouTube/); assert.equal(payload.embeds[0].timestamp, live.startedAt);
  assert.ok(!payload.content.includes(live.url), 'URL appears only in the card, avoiding duplicate automatic previews');
});

test('untrusted titles cannot create mentions, markdown links, or Chinese alert copy', () => {
  const payload = renderDiscordLiveNotice({ agent: '@everyone [click](https://evil.test)' }, { ...live, title: '比特币直播' }, new Date());
  assert.doesNotMatch(JSON.stringify(payload), /[\u3400-\u9fff]/);
  assert.ok(!payload.content.includes('@everyone')); assert.ok(!payload.embeds[0].description.includes('https://evil.test'));
  assert.equal(payload.embeds[0].title, 'YouTube livestream');
});

test('missing start time is omitted and historical edits do not claim a stream is live now', () => {
  const payload = renderDiscordLiveNotice(source, { ...live, startedAt: '' }, new Date(), { historical: true });
  assert.doesNotMatch(JSON.stringify(payload), /LIVE NOW|Started|timestamp/);
  assert.match(payload.embeds[0].description, /Watch on YouTube/);
});
