"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleShell from "../../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../../components/ui";

const TEMPLATES = [
  { value: "daily-events", label: "Daily Events", detail: "独立海报 + 英文正文" },
  { value: "daily-analysis", label: "Daily Analysis", detail: "每日行情图文分析" },
  { value: "whale-signals", label: "Whale Signals", detail: "巨鲸与大户挂单英文图文" },
  { value: "news", label: "News Feed", detail: "市场新闻自动整理" },
  { value: "agent-sync", label: "Agent Social Updates", detail: "代理 X / YouTube 更新" },
];

const SCHEDULES = [
  { value: "daily-0800-utc", label: "每日 08:00 UTC" },
  { value: "hourly", label: "每小时" },
  { value: "every-4-hours", label: "每 4 小时" },
  { value: "every-15-minutes", label: "每 15 分钟" },
  { value: "every-5-minutes", label: "每 5 分钟" },
];

export default function DiscordDistributionPage() {
  const [status, setStatus] = useState({ config: { guilds: {}, routes: [], demoGuildId: "", syncEnabled: false } });
  const [overview, setOverview] = useState({ rules: [] });
  const [health, setHealth] = useState({ summary: {}, guilds: [] });
  const [contentType, setContentType] = useState("daily-events");
  const [schedulePreset, setSchedulePreset] = useState("daily-0800-utc");
  const [taskName, setTaskName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [selectedChannelIds, setSelectedChannelIds] = useState([]);
  const [demoGuildId, setDemoGuildId] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");

  const applyStatus = useCallback((payload) => {
    const config = { guilds: {}, routes: [], demoGuildId: "", syncEnabled: false, ...(payload?.config || {}) };
    setStatus({ ...payload, config });
    setDemoGuildId(config.demoGuildId || "");
    setSyncEnabled(config.syncEnabled === true);
  }, []);

  const load = useCallback(async () => {
    setError("");
    try {
      const [discordResponse, distributionResponse] = await Promise.all([
        fetch("/api/discord", { cache: "no-store" }),
        fetch("/api/distribution", { cache: "no-store" }),
      ]);
      const [discordPayload, distributionPayload] = await Promise.all([discordResponse.json(), distributionResponse.json()]);
      if (!discordResponse.ok || !discordPayload.ok) throw new Error(discordPayload.error || "Discord 配置读取失败。");
      if (!distributionResponse.ok || !distributionPayload.ok) throw new Error(distributionPayload.error || "自动发布任务读取失败。");
      applyStatus(discordPayload);
      setOverview(distributionPayload.overview || distributionPayload.result?.overview || { rules: [] });
    } catch (requestError) {
      setError(requestError.message || "内容分发配置读取失败。");
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  const checkHealth = useCallback(async () => {
    try {
      const response = await fetch("/api/discord", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "health-check" }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "频道实时检测失败。");
      const next = payload.result?.health || { summary: {}, guilds: [] };
      setHealth(next);
      const sendable = new Set(next.guilds.flatMap((guild) => guild.channels || []).filter((channel) => channel.permissionsOk).map((channel) => channel.channelId));
      setSelectedChannelIds((current) => current.filter((id) => sendable.has(id)));
    } catch (requestError) {
      setError(requestError.message || "频道实时检测失败。");
    }
  }, []);

  useEffect(() => { load(); checkHealth(); }, [checkHealth, load]);

  const channelMap = useMemo(() => new Map(health.guilds.flatMap((guild) => (guild.channels || []).map((channel) => [channel.channelId, { guild, channel }]))), [health.guilds]);
  const discordRules = useMemo(() => (overview.rules || []).filter((rule) => rule.kind === "automation" && (rule.targets || []).some((target) => target.platform === "discord")), [overview.rules]);
  const configuredGuilds = useMemo(() => Object.values(status.config.guilds || {}).sort((a, b) => String(a.guildName).localeCompare(String(b.guildName))), [status.config.guilds]);

  function toggleChannel(channelId) {
    setSelectedChannelIds((current) => current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId]);
  }

  async function saveAutomation() {
    if (!selectedChannelIds.length) return setError("请至少选择一个已通过实时检测的目标 Channel。");
    setBusy(true); setError(""); setNotice("");
    try {
      const template = TEMPLATES.find((item) => item.value === contentType);
      const targets = selectedChannelIds.map((channelId) => {
        const { guild, channel } = channelMap.get(channelId);
        return { platform: "discord", guildId: guild.guildId, channelId, groupName: guild.guildName, topicName: channel.name, enabled: true };
      });
      const response = await fetch("/api/distribution", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rule: { kind: "automation", name: taskName.trim() || `${template.label} · Discord`, contentType, schedulePreset, enabled, targets } }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "自动发布任务保存失败。");
      setNotice("Discord 自动发布任务已保存；到点后会读取模板内容并自动分发。");
      setSelectedChannelIds([]); setTaskName("");
      await load();
    } catch (requestError) { setError(requestError.message || "自动发布任务保存失败。"); }
    finally { setBusy(false); }
  }

  async function saveSettings() {
    setBusy(true); setError(""); setNotice("");
    try {
      const response = await fetch("/api/discord", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "settings", demoGuildId, syncEnabled }) });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "同步设置保存失败。");
      applyStatus(payload); setNotice("Demo Server 与同步开关已保存。");
    } catch (requestError) { setError(requestError.message || "同步设置保存失败。"); }
    finally { setBusy(false); }
  }

  return <ConsoleShell>
    <PageHeader title="Discord 内容分发中心" desc="选择内容模板、目标 Server / Channel 和频率；系统到点自动读取并生成内容，无需手动输入正文。" action={<button type="button" onClick={checkHealth} className="rounded-lg border border-ops-line bg-white px-4 py-2 text-sm font-black">重新实时检测</button>} />
    {loading && <div className="mb-4 text-sm text-ops-muted">正在读取分发配置…</div>}
    {notice && <div className="mb-4 rounded-lg bg-[#e6f7ef] px-4 py-3 text-sm font-bold text-ops-accent">{notice}</div>}
    {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

    <div className="grid gap-6 xl:grid-cols-[minmax(320px,.75fr)_minmax(0,1.25fr)]">
      <Card className="p-6">
        <h2 className="text-xl font-black">选择内容模板</h2>
        <div className="mt-5 grid gap-4">
          <Field label="模板"><select className={inputClass} value={contentType} onChange={(event) => setContentType(event.target.value)}>{TEMPLATES.map((item) => <option key={item.value} value={item.value}>{item.label} · {item.detail}</option>)}</select></Field>
          <Field label="任务名称（可选）"><input className={inputClass} value={taskName} onChange={(event) => setTaskName(event.target.value)} placeholder="未填写时使用模板名称" /></Field>
          <Field label="定时频率"><select className={inputClass} value={schedulePreset} onChange={(event) => setSchedulePreset(event.target.value)}>{SCHEDULES.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></Field>
          <label className="flex min-h-10 items-center gap-2 rounded-lg border border-ops-line px-4 text-sm font-bold"><input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />保存后立即启用</label>
        </div>
      </Card>
      <Card className="p-6">
        <div className="flex items-center justify-between"><h2 className="text-xl font-black">选择目标 Server / Channel</h2><StatusPill tone={health.summary?.sendableChannels ? "green" : "amber"}>{health.summary?.sendableChannels || 0} 个可发送</StatusPill></div>
        <div className="mt-5 grid gap-3">
          {health.guilds.map((guild) => <details key={guild.guildId} className="rounded-lg border border-ops-line"><summary className="cursor-pointer list-none px-4 py-3 font-black">{guild.guildName} <span className="ml-2 text-xs text-ops-muted">{(guild.channels || []).filter((channel) => channel.permissionsOk).length}/{(guild.channels || []).length}</span></summary><div className="border-t border-ops-line p-3">{(guild.channels || []).map((channel) => <label key={channel.channelId} className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${channel.permissionsOk ? "hover:bg-ops-soft" : "opacity-50"}`}><span className="flex items-center gap-2"><input type="checkbox" disabled={!channel.permissionsOk} checked={selectedChannelIds.includes(channel.channelId)} onChange={() => toggleChannel(channel.channelId)} />#{channel.name}</span><StatusPill tone={channel.permissionsOk ? "green" : "gray"}>{channel.permissionsOk ? "可发送" : "权限不足"}</StatusPill></label>)}</div></details>)}
          {!loading && health.guilds.length === 0 && <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">暂无 Bot 可见的 Discord Server。</div>}
        </div>
        <button type="button" disabled={busy || !selectedChannelIds.length} onClick={saveAutomation} className="mt-5 rounded-lg bg-ops-accent px-5 py-2.5 text-sm font-black text-white disabled:opacity-50">保存自动发布任务（{selectedChannelIds.length} 个目标）</button>
      </Card>
    </div>

    <Card className="mt-6 p-6"><h2 className="text-xl font-black">已保存的 Discord 自动任务</h2><div className="mt-4 grid gap-3">{discordRules.map((rule) => <div key={rule.id} className="flex flex-col gap-2 rounded-lg border border-ops-line p-4 md:flex-row md:items-center md:justify-between"><div><div className="font-black">{rule.name}</div><div className="mt-1 text-xs text-ops-muted">{rule.contentType} · {rule.schedulePreset} · {(rule.targets || []).filter((target) => target.platform === "discord").length} 个目标</div></div><StatusPill tone={rule.enabled === false ? "gray" : "green"}>{rule.enabled === false ? "已暂停" : "运行中"}</StatusPill></div>)}{!discordRules.length && <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">暂无 Discord 自动发布任务。</div>}</div></Card>

    <Card className="mt-6 p-6">
      <h2 className="text-xl font-black">Demo → 目标同步规则</h2><p className="mt-2 text-sm text-ops-muted">同步与自动分发相互独立；路由按稳定的 Server ID + Channel ID 保存。</p>
      <div className="mt-5 grid gap-4 md:grid-cols-[1fr_auto] md:items-end"><Field label="Discord Demo Server"><select className={inputClass} value={demoGuildId} onChange={(event) => setDemoGuildId(event.target.value)}><option value="">请选择已初始化 Server</option>{configuredGuilds.map((guild) => <option key={guild.guildId} value={guild.guildId}>{guild.guildName}</option>)}</select></Field><label className="flex min-h-10 items-center gap-2 rounded-lg border border-ops-line px-4 text-sm font-bold"><input type="checkbox" checked={syncEnabled} onChange={(event) => setSyncEnabled(event.target.checked)} />启用 Discord 同步</label></div>
      <button type="button" disabled={busy} onClick={saveSettings} className="mt-4 rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white disabled:opacity-50">保存基础设置</button>
      <div className="mt-6 grid gap-3">{(status.config.routes || []).map((route, index) => <div key={route.id || index} className="flex flex-col gap-2 rounded-lg border border-ops-line p-4 md:flex-row md:items-center md:justify-between"><div className="text-sm font-bold">{route.sourceGuildName || route.sourceGuildId} / #{route.sourceChannelName || route.sourceChannelId} → {route.targetGuildName || route.targetGuildId} / #{route.targetChannelName || route.targetChannelId}</div><StatusPill tone={route.enabled === false ? "gray" : "green"}>{route.enabled === false ? "已暂停" : "运行中"}</StatusPill></div>)}{!(status.config.routes || []).length && <div className="rounded-lg border border-dashed border-ops-line p-5 text-sm text-ops-muted">暂无 Demo → 目标同步规则。</div>}</div>
    </Card>
  </ConsoleShell>;
}
