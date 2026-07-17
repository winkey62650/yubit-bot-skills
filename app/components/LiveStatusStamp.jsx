"use client";

import { useEffect, useState } from "react";
import { getFriendlyRefreshError, getLiveFreshness } from "../../lib/live-status.mjs";
import { StatusPill } from "./ui";

export default function LiveStatusStamp({ generatedAt, error = "", refreshing = false }) {
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 10_000);
    return () => window.clearInterval(timer);
  }, []);

  const freshness = getLiveFreshness(generatedAt, { now });
  const friendlyError = getFriendlyRefreshError(error);
  const label = refreshing ? "正在实时核验" : freshness.label;
  const tone = refreshing ? "amber" : freshness.tone;

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-ops-muted" data-live-status={freshness.state}>
      <StatusPill tone={tone}>{label}</StatusPill>
      <span>{generatedAt ? `Telegram 核验时间：${new Date(generatedAt).toLocaleString("zh-CN")}` : "尚无 Telegram 核验结果"}</span>
      <span>· 页面可见时每 30 秒自动刷新</span>
      {friendlyError ? <span className="font-bold text-[#c98118]">· 最近一次刷新失败：{friendlyError}</span> : null}
    </div>
  );
}
