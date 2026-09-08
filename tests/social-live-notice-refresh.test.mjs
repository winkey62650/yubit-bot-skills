import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshSocialLiveNotice } from '../lib/social-live-notice-refresh.mjs';
import { editDiscordLiveNotice } from '../lib/discord-service.mjs';

const target = { platform: 'discord', guildId: '10', channelId: '20' };
const live = { platform: 'YouTube', id: 'xrBzglllmb8', title: 'Market live', startedAt: '2026-09-08T13:01:43Z' };
const delivery = { id: 'delivery', eventId: 'event', ruleId: 'system-social-live-notices-v1', status: 'success', target, targetMessageId: '30', attempts: 1, payload: { socialLiveSourceId: 's' } };
const sources = [{ id: 's', agent: 'Average Joe Crypto', targets: [target] }];

test('format repair only edits the recorded message and preserves delivery identity and attempts', async () => {
  const writes = [], edits = [];
  const repository = { getDelivery: async () => delivery, getEvent: async () => ({ payload: { sourceId: 's', live } }), updateDelivery: async (id, patch) => writes.push({ id, patch }) };
  const options = { repository, sources, editor: async (...args) => { edits.push(args); return { messageId: '30' }; } };
  const preview = await refreshSocialLiveNotice('delivery', { ...options, previewOnly: true });
  assert.equal(edits.length, 0); assert.equal(writes.length, 0); assert.doesNotMatch(preview.payload.content, /LIVE NOW/);
  await refreshSocialLiveNotice('delivery', options);
  assert.deepEqual(edits[0].slice(0, 2), ['20', '30']);
  assert.deepEqual(Object.keys(writes[0].patch), ['payload']);
  assert.equal(writes[0].patch.payload.socialLiveSourceId, 's');
});

test('unconfirmed deliveries and removed targets cannot be reformatted', async () => {
  for (const bad of [{ ...delivery, status: 'pending' }, { ...delivery, ruleId: 'other' }, { ...delivery, target: { ...target, channelId: '999' } }]) {
    await assert.rejects(refreshSocialLiveNotice('delivery', { repository: { getDelivery: async () => bad, getEvent: async () => ({ payload: { sourceId: 's', live } }) }, sources, editor: async () => { throw new Error('must not edit'); } }), /confirmed|destination/);
  }
});

test('Discord edits require bot ownership and the matching live URL, never a new send', async () => {
  const url = 'https://www.youtube.com/watch?v=xrBzglllmb8';
  const payload = { content: 'English stream card', embeds: [{ title: 'Market live', url, description: `[Watch on YouTube](${url})` }] };
  for (const own of [true, false]) {
    const calls = []; let edited = false;
    const fetchImpl = async (endpoint, init) => {
      calls.push({ endpoint, method: init.method || 'GET' });
      if (endpoint.endsWith('/users/@me')) return Response.json({ id: '50' });
      if (init.method === 'PATCH') { const body = JSON.parse(init.body); assert.deepEqual(body.allowed_mentions, { parse: [] }); edited = true; return Response.json({ id: '30' }); }
      return Response.json({ id: '30', channel_id: '20', author: { id: own ? '50' : '99' }, ...(edited ? payload : { content: `Old notice ${url}` }) });
    };
    const promise = editDiscordLiveNotice('20', '30', url, payload, { botToken: 'private-test-token', fetchImpl, repository: { getMeta: async () => null } });
    if (own) { await promise; assert.equal(calls.filter(c => c.method === 'PATCH').length, 1); }
    else { await assert.rejects(promise, /not owned/); assert.equal(edited, false); }
    assert.equal(calls.some(c => c.method === 'POST'), false);
  }
});
