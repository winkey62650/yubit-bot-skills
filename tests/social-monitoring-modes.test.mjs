import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeSocialPackages } from '../lib/social-sources.mjs';
import { buildContent, previewSocialSource } from '../lib/automation-jobs.mjs';
import { runSocialLiveMonitor } from '../lib/social-live-monitor.mjs';
import { writeJson } from '../lib/json-store.js';

const source = { id: 'live-only', agent: 'QA', platform: 'YouTube', accountUrl: 'https://youtube.com/@qa', status: '已启用', postMonitoring: false, liveMonitoring: true, targets: [{ chatId: '-1001', threadId: 8 }] };

test('legacy sources retain posts while an explicit live-only source survives normalization', () => {
  const [legacy, liveOnly] = normalizeSocialPackages([{ ...source, postMonitoring: undefined }, source]);
  assert.equal(legacy.postMonitoring, true);
  assert.equal(liveOnly.postMonitoring, false);
  assert.equal(normalizeSocialPackages([liveOnly])[0].postMonitoring, false);
});

test('a configured X key with no credits does not disable existing public post discovery', async () => {
  const priorToken = process.env.X_BEARER_TOKEN;
  const priorFetch = globalThis.fetch;
  const calls = [];
  process.env.X_BEARER_TOKEN = 'synthetic-key';
  globalThis.fetch = async (url, options) => {
    calls.push(String(url));
    if (new URL(url).hostname === 'api.x.com') return new Response('{}', { status: 402 });
    assert.equal(options.headers.authorization, undefined, 'Bearer must not be sent to public fallback');
    return new Response('<article itemType="https://schema.org/SocialMediaPosting" data-tweet-id="123"><meta itemProp="identifier" content="123"/><meta itemProp="datePublished" content="2026-09-08T08:00:00Z"/><meta itemProp="url" content="https://x.com/qa/status/123"/><meta itemProp="articleBody" content="Public account update"/><meta itemProp="alternateName" content="qa"/></article>');
  };
  try {
    const result = await previewSocialSource({ agent: 'QA', platform: 'X', accountUrl: 'https://x.com/qa' });
    assert.equal(result.url, 'https://x.com/qa/status/123');
    assert.equal(result.strategy, 'x-profile');
    assert.deepEqual(calls.map(u => new URL(u).hostname), ['api.x.com', 'x.com']);
    globalThis.fetch = async () => new Response('{}', { status: 503 });
    await assert.rejects(previewSocialSource({ agent: 'QA', platform: 'X', accountUrl: 'https://x.com/qa' }), /X/);
  } finally {
    globalThis.fetch = priorFetch;
    if (priorToken === undefined) delete process.env.X_BEARER_TOKEN; else process.env.X_BEARER_TOKEN = priorToken;
  }
});

test('live-only sources cannot enter ordinary post discovery but still enter the live scheduler', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'yubit-live-only-'));
  const priorDirectory = process.env.JSON_STORE_DIRECTORY;
  const priorBackend = process.env.JSON_STORE_BACKEND;
  const priorFetch = globalThis.fetch;
  let postCalls = 0;
  process.env.JSON_STORE_DIRECTORY = directory;
  process.env.JSON_STORE_BACKEND = 'local';
  globalThis.fetch = async () => { postCalls++; throw new Error('Unexpected post discovery'); };
  try {
    await writeJson('social-packages.json', { packages: [source] });
    const posts = await buildContent('agent-sync-4h', new Date('2026-09-08T08:00:00Z'), { persist: false });
    assert.equal(postCalls, 0);
    assert.deepEqual(posts.updates, []);
    assert.deepEqual(posts.items, []);
    let liveCalls = 0;
    const live = await runSocialLiveMonitor({
      dryRun: true,
      repository: { getMeta: async () => null },
      detect: async () => { liveCalls++; return { provider: 'YouTube Live', broadcasts: [] }; },
    });
    assert.equal(liveCalls, 1);
    assert.equal(live.sources[0].state, 'offline');
    await writeJson('social-packages.json', { packages: [{ ...source, status: '已暂停' }] });
    await runSocialLiveMonitor({ dryRun: true, repository: {}, detect: async () => { liveCalls++; } });
    assert.equal(liveCalls, 1, 'Master pause must still stop live discovery');
  } finally {
    globalThis.fetch = priorFetch;
    if (priorDirectory === undefined) delete process.env.JSON_STORE_DIRECTORY; else process.env.JSON_STORE_DIRECTORY = priorDirectory;
    if (priorBackend === undefined) delete process.env.JSON_STORE_BACKEND; else process.env.JSON_STORE_BACKEND = priorBackend;
    await rm(directory, { recursive: true, force: true });
  }
});
