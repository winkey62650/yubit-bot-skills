import { NextResponse } from 'next/server';
import { readJson } from '../../../lib/json-store.js';
import { normalizeSocialPackages } from '../../../lib/social-sources.mjs';
import { getSocialLiveStatus } from '../../../lib/social-live-monitor.mjs';
import { detectSocialLive } from '../../../lib/social-live-sources.mjs';
import { renderDiscordLiveNotice, renderSocialLiveNotice } from '../../../lib/social-live-notice.mjs';
import { refreshSocialLiveNotice } from '../../../lib/social-live-notice-refresh.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET() {
  try {
    const saved = await readJson('social-packages.json', { packages: [] });
    return NextResponse.json({ ok: true, sources: await getSocialLiveStatus(normalizeSocialPackages(saved.packages || saved)), intervalMinutes: 5 });
  } catch { return NextResponse.json({ ok: false, error: '直播监控状态读取失败' }, { status: 503 }); }
}
// Tests are read-only; format repair can only edit a confirmed recorded message.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (['preview-notice', 'refresh-notice'].includes(body.action)) {
    try { return NextResponse.json({ ok: true, result: await refreshSocialLiveNotice(body.deliveryId, { previewOnly: body.action === 'preview-notice' }) }); }
    catch (error) { return NextResponse.json({ ok: false, error: error.message }, { status: 422 }); }
  }
  if (body.action !== 'test') return NextResponse.json({ ok: false, error: '不支持的直播操作' }, { status: 400 });
  try {
    const source = normalizeSocialPackages([body.source])[0];
    if (!source) throw new Error('请填写来源名称、代理和账号主页');
    const preview = await detectSocialLive(source, { signal: AbortSignal.timeout(45_000), ...(body.discovery === 'fast' ? { discovery: { search: false } } : {}) });
    const checkedAt = new Date().toISOString();
    return NextResponse.json({ ok: true, preview: { ...preview, checkedAt, notices: preview.broadcasts.map(live => ({ liveId: live.id, discord: renderDiscordLiveNotice(source, live, checkedAt), text: renderSocialLiveNotice(source, live, checkedAt) })) } });
  } catch (error) { return NextResponse.json({ ok: false, error: error.message }, { status: 422 }); }
}
