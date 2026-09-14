import { NextResponse } from 'next/server';
import { readJson } from '../../../lib/json-store.js';
import { normalizeSocialPackages } from '../../../lib/social-sources.mjs';
import { getSocialPostStatus } from '../../../lib/social-post-monitor.mjs';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';
export async function GET() {
  try {
    const saved = await readJson('social-packages.json', { packages: [] });
    return NextResponse.json({ ok: true, sources: await getSocialPostStatus(normalizeSocialPackages(saved.packages || saved)) });
  } catch { return NextResponse.json({ ok: false, error: '普通更新状态读取失败' }, { status: 503 }); }
}
