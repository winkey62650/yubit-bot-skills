import { NextResponse } from 'next/server';
import { readJson } from '../../../lib/json-store.js';
import { normalizeSocialPackages } from '../../../lib/social-sources.mjs';
import { getSocialLiveStatus } from '../../../lib/social-live-monitor.mjs';
import { detectSocialLive } from '../../../lib/social-live-sources.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET() {
  try {
    const saved = await readJson('social-packages.json', { packages: [] });
    return NextResponse.json({ ok: true, sources: await getSocialLiveStatus(normalizeSocialPackages(saved.packages || saved)), intervalMinutes: 5 });
  } catch { return NextResponse.json({ ok: false, error: '直播监控状态读取失败' }, { status: 503 }); }
}
// Read-only provider test. It never enqueues or acknowledges notifications.
export async function POST(request) {
  const body = await request.json().catch(() => ({}));
  if (body.action !== 'test') return NextResponse.json({ ok: false, error: '仅支持直播状态检测' }, { status: 400 });
  try {
    const source = normalizeSocialPackages([body.source])[0];
    if (!source) throw new Error('请填写来源名称、代理和账号主页');
    const preview = await detectSocialLive(source, { signal: AbortSignal.timeout(45_000) });
    return NextResponse.json({ ok: true, preview: { ...preview, checkedAt: new Date().toISOString() } });
  } catch (error) { return NextResponse.json({ ok: false, error: error.message }, { status: 422 }); }
}
