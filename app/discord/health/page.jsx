"use client";

import { useCallback, useEffect, useState } from "react";

import ConsoleShell from "../../components/ConsoleShell";
import { Card, PageHeader, StatusPill } from "../../components/ui";

function formatTime(value) {
  if (!value) return "尚未检测";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "尚未检测" : date.toLocaleString("zh-CN", { hour12: false });
}

export default function DiscordHealthPage() {
  const [health, setHealth] = useState({ checkedAt: null, bot: null, summary: {}, guilds: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const check = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/discord", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "health-check" }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "实时检测失败。");
      setHealth(payload.result?.health || { checkedAt: null, bot: null, summary: {}, guilds: [] });
    } catch (requestError) {
      setError(requestError.message || "实时检测失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    check();
    const timer = window.setInterval(check, 30000);
    return () => window.clearInterval(timer);
  }, [check]);

  const { checkedAt, summary = {} } = health;

  return (
    <ConsoleShell>
      <PageHeader title="Server 与 Channel 健康" desc="实时检测 Bot 对每个 Server 与 Channel 的查看、发送、Embed 和附件权限；每 30 秒自动刷新。" action={<button type="button" onClick={check} className="rounded-lg bg-ops-ink px-4 py-2 text-sm font-black text-white">立即实时检测</button>} />
      {loading && <div className="mb-4 text-sm text-ops-muted">正在执行实时检测…</div>}
      {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">最后检测</div><div className="mt-2 text-sm font-black">{formatTime(checkedAt)}</div></Card>
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">Server</div><div className="mt-2 text-2xl font-black">{summary.guilds || 0}</div></Card>
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">可发送 Channel</div><div className="mt-2 text-2xl font-black text-ops-accent">{summary.sendable || 0}</div></Card>
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">异常 Channel</div><div className="mt-2 text-2xl font-black text-amber-700">{summary.blocked || 0}</div></Card>
      </div>

      <div className="grid gap-5">
        {health.guilds.map((guild) => <Card key={guild.guildId} className="overflow-hidden"><div className="flex items-center justify-between border-b border-ops-line px-5 py-4"><div><h2 className="font-black">{guild.guildName}</h2><div className="mt-1 text-xs text-ops-muted">{guild.guildId}</div></div><StatusPill tone={guild.available ? "green" : "amber"}>{guild.available ? "Server 可访问" : guild.error || "不可访问"}</StatusPill></div><div className="divide-y divide-ops-line">{(guild.channels || []).map((channel) => <div key={channel.channelId} className="grid gap-3 px-5 py-4 md:grid-cols-[minmax(180px,1fr)_repeat(4,auto)] md:items-center"><div><div className="font-bold">#{channel.name}</div><div className="mt-1 text-xs text-ops-muted">{channel.channelId}</div></div><StatusPill tone={channel.canView ? "green" : "gray"}>查看 {channel.canView ? "✓" : "×"}</StatusPill><StatusPill tone={channel.canSend ? "green" : "amber"}>发送 {channel.canSend ? "✓" : "×"}</StatusPill><StatusPill tone={channel.canEmbed ? "green" : "gray"}>Embed {channel.canEmbed ? "✓" : "×"}</StatusPill><StatusPill tone={channel.canAttach ? "green" : "gray"}>附件 {channel.canAttach ? "✓" : "×"}</StatusPill></div>)}</div></Card>)}
        {!loading && health.guilds.length === 0 && <Card className="p-6 text-sm text-ops-muted">暂无已初始化的 Discord Server，请先在 Discord 社区完成 Bot 安装和频道初始化。</Card>}
      </div>
    </ConsoleShell>
  );
}
