"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleShell from "../../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../../components/ui";
import { filterDiscordGuildChannels } from "../../../lib/discord-channel-search.mjs";

const TEMPLATE_OPTIONS = [
  { value: "daily-events", label: "Daily Market Events", hint: "每日市场事件：独立海报 + 英文正文" },
  { value: "daily-analysis", label: "Daily Market Analysis", hint: "每日行情分析：图文模板" },
  { value: "whale-signals", label: "Whale Signals", hint: "巨鲸数据：英文图文模板" },
  { value: "news", label: "Market News", hint: "市场新闻模板" },
  { value: "agent-sync", label: "Agent Social Updates", hint: "代理 X / YouTube 更新模板" },
];

export default function DiscordManualPage() {
  const [health, setHealth] = useState({ checkedAt: null, summary: {}, guilds: [] });
  const [selectedTemplate, setSelectedTemplate] = useState("daily-events");
  const [manualChannelIds, setManualChannelIds] = useState([]);
  const [manualResults, setManualResults] = useState([]);
  const [guildSearch, setGuildSearch] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const checkHealth = useCallback(async () => {
    setError("");
    try {
      const response = await fetch("/api/discord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "health-check" }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "频道健康检查失败。");
      const next = payload.result?.health || { checkedAt: null, summary: {}, guilds: [] };
      setHealth(next);
      const sendable = new Set(next.guilds.flatMap((guild) => guild.channels || []).filter((channel) => channel.permissionsOk).map((channel) => channel.channelId));
      setManualChannelIds((current) => current.filter((channelId) => sendable.has(channelId)));
    } catch (requestError) {
      setError(requestError.message || "频道健康检查失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { checkHealth(); }, [checkHealth]);

  const healthyCount = useMemo(() => health.guilds.flatMap((guild) => guild.channels || []).filter((channel) => channel.permissionsOk).length, [health.guilds]);
  const filteredGuilds = useMemo(() => filterDiscordGuildChannels(health.guilds, guildSearch), [guildSearch, health.guilds]);

  function toggleChannel(channelId) {
    setManualChannelIds((current) => current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId]);
  }

  async function publish() {
    if (!selectedTemplate) return setError("请选择内容模板。");
    if (!manualChannelIds.length) return setError("请至少选择一个实时检测通过的频道。");
    setBusy(true);
    setError("");
    setNotice("");
    setManualResults([]);
    try {
      const response = await fetch("/api/discord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "template-publish", contentType: selectedTemplate, channelIds: manualChannelIds }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "模板发布失败。");
      const result = payload.result?.templatePublish || { delivered: 0, failed: 0, results: [] };
      setManualResults(result.results || []);
      setNotice(result.message || `发布完成：成功 ${result.delivered || 0} 个，失败 ${result.failed || 0} 个。`);
    } catch (requestError) {
      setError(requestError.message || "模板发布失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConsoleShell>
      <PageHeader title="Discord 手动信息发布" desc="选择已定稿的内容模板和目标频道；正文与配图由服务器生成，不再手动输入。" action={<button type="button" onClick={checkHealth} className="rounded-lg border border-ops-line bg-white px-4 py-2 text-sm font-black">重新实时检测</button>} />
      {loading && <div className="mb-4 text-sm text-ops-muted">正在检测可发送频道…</div>}
      {notice && <div className="mb-4 rounded-lg bg-[#e6f7ef] px-4 py-3 text-sm font-bold text-ops-accent">{notice}</div>}
      {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
        <Card className="p-6">
          <div className="flex items-center justify-between"><h2 className="text-xl font-black">发布目标</h2><StatusPill tone={healthyCount ? "green" : "amber"}>{healthyCount} 个可发送</StatusPill></div>
          <div className="mt-5 grid gap-3">
            <Field label="搜索可发言频道"><input type="search" className={inputClass} value={guildSearch} onChange={(event) => setGuildSearch(event.target.value)} placeholder="搜索 Server 或 Channel 名称" /></Field>
            {filteredGuilds.map((guild) => <details key={guild.guildId} open={guildSearch.trim() ? true : undefined} className="rounded-lg border border-ops-line"><summary className="cursor-pointer list-none px-4 py-3 font-black">{guild.guildName} <span className="ml-2 text-xs text-ops-muted">{(guild.channels || []).filter((channel) => channel.permissionsOk).length}/{(guild.channels || []).length}</span></summary><div className="border-t border-ops-line p-3">{(guild.channels || []).map((channel) => <label key={channel.channelId} className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${channel.permissionsOk ? "hover:bg-ops-soft" : "opacity-50"}`}><span className="flex items-center gap-2"><input type="checkbox" disabled={!channel.permissionsOk} checked={manualChannelIds.includes(channel.channelId)} onChange={() => toggleChannel(channel.channelId)} />#{channel.name}</span><StatusPill tone={channel.permissionsOk ? "green" : "gray"}>{channel.permissionsOk ? "可发送" : channel.error || "权限不完整"}</StatusPill></label>)}</div></details>)}
            {!loading && health.guilds.length === 0 && <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">暂无 Bot 可见的 Discord Server。</div>}
            {!loading && health.guilds.length > 0 && filteredGuilds.length === 0 && <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">没有匹配的 Server 或 Channel。</div>}
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-xl font-black">选择内容模板</h2>
          <div className="mt-5 grid gap-3">
            {TEMPLATE_OPTIONS.map((option) => <label key={option.value} className={`cursor-pointer rounded-lg border p-4 ${selectedTemplate === option.value ? "border-ops-accent bg-[#effaf5]" : "border-ops-line"}`}><div className="flex items-start gap-3"><input type="radio" name="discord-template" value={option.value} checked={selectedTemplate === option.value} onChange={(event) => setSelectedTemplate(event.target.value)} className="mt-1" /><div><div className="font-black">{option.label}</div><div className="mt-1 text-sm text-ops-muted">{option.hint}</div></div></div></label>)}
          </div>
          <div className="mt-5 rounded-lg bg-ops-soft px-4 py-3 text-sm text-ops-muted">发布时读取最新数据，按所选模板生成正文和配图，并逐个投递到已通过实时权限检测的频道。</div>
          <button type="button" disabled={busy || manualChannelIds.length === 0} onClick={publish} className="mt-5 rounded-lg bg-ops-accent px-5 py-2.5 text-sm font-black text-white disabled:opacity-50">{busy ? "正在生成并发布…" : `发送到 ${manualChannelIds.length} 个频道`}</button>

          {manualResults.length > 0 && <div className="mt-6 grid gap-2"><h3 className="font-black">逐目标结果</h3>{manualResults.map((result, index) => <div key={`${result.channelId || result.targetKey}-${index}`} className="flex items-center justify-between rounded-lg border border-ops-line px-3 py-2 text-sm"><span>#{result.channelName || result.channelId || result.targetKey}</span><StatusPill tone={result.ok ? "green" : "amber"}>{result.ok ? "成功" : result.error || "失败"}</StatusPill></div>)}</div>}
        </Card>
      </div>
    </ConsoleShell>
  );
}
