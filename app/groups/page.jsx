"use client";

import { useEffect, useMemo, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import LiveStatusStamp from "../components/LiveStatusStamp";
import { useLiveAutoRefresh } from "../hooks/useLiveAutoRefresh";
import { Card, PageHeader, StatusPill } from "../components/ui";
import { getLiveFreshness } from "../../lib/live-status.mjs";

export default function GroupsPage() {
  const [data, setData] = useState({ ok: false, groups: [], sourceNote: "" });
  const [loading, setLoading] = useState(true);
  const [refreshError, setRefreshError] = useState("");

  useEffect(() => {
    let cancelled = false;
    load({ cancelled: () => cancelled }).catch((error) => {
      if (!cancelled) {
        setData({ ok: false, error: error.message, groups: [] });
        setRefreshError(error.message);
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  async function load({ silent = false, cancelled = () => false } = {}) {
    if (!silent) setLoading(true);
    try {
      const response = await fetch(`/api/group-metrics?refresh=${Date.now()}`, { cache: "no-store" });
      const nextData = await response.json();
      if (!response.ok || !nextData.ok) throw new Error(nextData.error || "群状态核验失败");
      if (!cancelled()) {
        setData(nextData);
        setRefreshError("");
      }
    } catch (error) {
      if (!cancelled()) setRefreshError(error.message);
      if (!silent) throw error;
    } finally {
      if (!cancelled() && !silent) setLoading(false);
    }
  }

  useLiveAutoRefresh(() => load({ silent: true }), { enabled: !loading });

  const freshness = getLiveFreshness(data.generatedAt);
  const isFresh = freshness.state === "fresh";

  const totals = useMemo(() => {
    return data.groups.reduce(
      (sum, group) => ({
        members: sum.members + Number(group.memberCount || 0),
        messages: sum.messages + Number(group.visibleMessageCount || 0),
        activeUsers: sum.activeUsers + Number(group.sevenDayActiveUsers || 0)
      }),
      { members: 0, messages: 0, activeUsers: 0 }
    );
  }, [data.groups]);

  return (
    <ConsoleShell>
      <PageHeader title="群数据" desc="查看已接入群组、用户人数、历史消息可见量和近 7 天活跃用户。" />
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <LiveStatusStamp generatedAt={data.generatedAt} error={refreshError} refreshing={loading} />
        <button className="rounded-lg border border-ops-line bg-white px-4 py-2 text-sm font-black text-ops-accent" onClick={() => load()} disabled={loading}>
          {loading ? "正在核验" : "立即刷新"}
        </button>
      </div>
      <div className="mb-5 grid gap-4 md:grid-cols-3">
        <Metric label="群用户人数" value={isFresh ? formatNumber(totals.members) : "-"} />
        <Metric label="Bot 可见消息数量" value={isFresh ? formatNumber(totals.messages) : "-"} />
        <Metric label="Bot 可见的 7 天活跃用户" value={isFresh ? formatNumber(totals.activeUsers) : "-"} />
      </div>
      <Card className="overflow-hidden">
        <div className="grid grid-cols-[1.4fr_1fr_.8fr_.9fr_.9fr_.8fr] gap-4 border-b border-ops-line bg-[#f9fbfa] px-5 py-3 text-xs font-black uppercase text-ops-muted">
          <span>群组</span><span>群 ID</span><span>用户人数</span><span>历史消息</span><span>7 天活跃</span><span>状态</span>
        </div>
        {loading && <div className="px-5 py-8 text-sm font-bold text-ops-muted">正在读取 Telegram 群数据...</div>}
        {!loading && data.groups.map((group) => (
          <div className="grid grid-cols-[1.4fr_1fr_.8fr_.9fr_.9fr_.8fr] gap-4 border-b border-ops-line px-5 py-4 text-sm last:border-b-0" key={group.id}>
            <strong>{group.title}</strong>
            <span>{group.id}</span>
            <span>{isFresh ? formatNumber(group.memberCount) : "-"}</span>
            <span>{isFresh ? formatNumber(group.visibleMessageCount) : "-"}</span>
            <span>{isFresh ? formatNumber(group.sevenDayActiveUsers) : "-"}</span>
            <span>
              <StatusPill tone={isFresh && group.status !== "需检查" ? "green" : "amber"}>
                {isFresh ? group.status : freshness.state === "stale" ? "状态已过期" : "等待核验"}
              </StatusPill>
            </span>
          </div>
        ))}
        {!loading && data.groups.length === 0 && <div className="px-5 py-8 text-sm font-bold text-ops-muted">{data.error || "暂无可读取群数据"}</div>}
      </Card>
      <p className="mt-3 text-xs font-bold text-ops-muted">{data.sourceNote || "所有数据均以最近一次 Telegram 实时核验为准。"}</p>
    </ConsoleShell>
  );
}

function Metric({ label, value }) {
  return (
    <Card className="p-5">
      <div className="text-sm font-bold text-ops-muted">{label}</div>
      <div className="mt-2 text-3xl font-black">{value}</div>
    </Card>
  );
}

function formatNumber(value) {
  if (value == null) return "-";
  return new Intl.NumberFormat("zh-CN").format(value);
}
