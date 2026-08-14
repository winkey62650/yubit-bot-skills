"use client";

import { useCallback, useEffect, useState } from "react";

import ConsoleShell from "../../components/ConsoleShell";
import { Card, PageHeader, StatusPill } from "../../components/ui";

function formatTime(value) {
  if (!value) return "尚未检测";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "尚未检测" : date.toLocaleString("zh-CN", { hour12: false });
}

const PERMISSION_LABELS = {
  ViewChannel: "查看频道",
  SendMessages: "发送消息",
  EmbedLinks: "嵌入链接",
  AttachFiles: "上传附件",
  ReadMessageHistory: "读取历史消息",
  ManageChannels: "管理频道",
};

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
      <PageHeader title="Server 与 Channel 健康" desc="每 30 秒实时检测查看、发送、Embed、附件、历史读取和频道管理权限。" action={<button type="button" onClick={check} className="rounded-lg bg-ops-ink px-4 py-2 text-sm font-black text-white">立即实时检测</button>} />
      {loading && <div className="mb-4 text-sm text-ops-muted">正在执行实时检测…</div>}
      {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}
      <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">Discord 不允许 Bot 自行提升角色权限。检测到缺失时，请由该 Server 的拥有者点击“重新授权并补齐权限”；授权完成后本页会自动复检。</div>

      <div className="mb-6 grid gap-4 md:grid-cols-4">
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">最后检测</div><div className="mt-2 text-sm font-black">{formatTime(checkedAt)}</div></Card>
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">Server</div><div className="mt-2 text-2xl font-black">{summary.guilds || 0}</div></Card>
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">可发送 Channel</div><div className="mt-2 text-2xl font-black text-ops-accent">{summary.sendableChannels || 0}</div></Card>
        <Card className="p-5"><div className="text-sm font-bold text-ops-muted">异常 Channel</div><div className="mt-2 text-2xl font-black text-amber-700">{summary.blockedChannels || 0}</div></Card>
      </div>

      <div className="grid gap-5">
        {health.guilds.map((guild) => <Card key={guild.guildId} className="overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-ops-line px-5 py-4">
            <div><h2 className="font-black">{guild.guildName}</h2><div className="mt-1 text-xs text-ops-muted">{guild.guildId}</div></div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusPill tone={guild.permissionsOk ? "green" : "amber"}>{guild.permissionsOk ? "全部权限已就绪" : guild.available ? "需要补齐权限" : guild.error || "不可访问"}</StatusPill>
              {!guild.permissionsOk && guild.reauthorizeUrl && <a href={guild.reauthorizeUrl} target="_blank" rel="noreferrer" className="rounded-lg bg-ops-accent px-3 py-2 text-xs font-black text-white">重新授权并补齐权限</a>}
            </div>
          </div>
          {(guild.missingPermissions || []).length > 0 && <div className="border-b border-amber-200 bg-amber-50 px-5 py-3 text-sm text-amber-900">缺失：{guild.missingPermissions.map((permission) => PERMISSION_LABELS[permission] || permission).join("、")}</div>}
          <div className="divide-y divide-ops-line">{(guild.channels || []).map((channel) => <div key={channel.channelId} className="grid gap-3 px-5 py-4 xl:grid-cols-[minmax(180px,1fr)_repeat(6,auto)] xl:items-center">
            <div><div className="font-bold">#{channel.name}</div><div className="mt-1 text-xs text-ops-muted">{channel.channelId}</div></div>
            <StatusPill tone={channel.canView ? "green" : "gray"}>查看 {channel.canView ? "✓" : "×"}</StatusPill>
            <StatusPill tone={channel.canSend ? "green" : "amber"}>发送 {channel.canSend ? "✓" : "×"}</StatusPill>
            <StatusPill tone={channel.canEmbed ? "green" : "gray"}>Embed {channel.canEmbed ? "✓" : "×"}</StatusPill>
            <StatusPill tone={channel.canAttach ? "green" : "gray"}>附件 {channel.canAttach ? "✓" : "×"}</StatusPill>
            <StatusPill tone={channel.canReadHistory ? "green" : "gray"}>历史 {channel.canReadHistory ? "✓" : "×"}</StatusPill>
            <StatusPill tone={channel.canManageChannels ? "green" : "gray"}>管理 {channel.canManageChannels ? "✓" : "×"}</StatusPill>
          </div>)}</div>
        </Card>)}
        {!loading && health.guilds.length === 0 && <Card className="p-6 text-sm text-ops-muted">暂无 Bot 可见的 Discord Server，请先完成 Bot 安装；安装后刷新即可发现全部 Server 与 Channel。</Card>}
      </div>
    </ConsoleShell>
  );
}
