"use client";

import { useEffect, useMemo, useState } from "react";
import ConsoleShell from "../components/ConsoleShell";
import { Card, PageHeader, StatusPill } from "../components/ui";

export default function GroupsPage() {
  const [data, setData] = useState({ ok: false, groups: [], sourceNote: "" });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      const response = await fetch("/api/group-metrics");
      const nextData = await response.json();
      if (!cancelled) {
        setData(nextData);
        setLoading(false);
      }
    }
    load().catch((error) => {
      if (!cancelled) {
        setData({ ok: false, error: error.message, groups: [] });
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

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
      <div className="mb-5 grid gap-4 md:grid-cols-3">
        <Metric label="群用户人数" value={formatNumber(totals.members)} />
        <Metric label="历史信息发表数量" value={formatNumber(totals.messages)} />
        <Metric label="过去 7 天活跃用户" value={formatNumber(totals.activeUsers)} />
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
            <span>{formatNumber(group.memberCount)}</span>
            <span>{formatNumber(group.visibleMessageCount)}</span>
            <span>{formatNumber(group.sevenDayActiveUsers)}</span>
            <span><StatusPill tone={group.status === "需检查" ? "amber" : "green"}>{group.status}</StatusPill></span>
          </div>
        ))}
        {!loading && data.groups.length === 0 && <div className="px-5 py-8 text-sm font-bold text-ops-muted">{data.error || "暂无可读取群数据"}</div>}
      </Card>
      <p className="mt-3 text-xs font-bold text-ops-muted">{data.sourceNote}</p>
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
