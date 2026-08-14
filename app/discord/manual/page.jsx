"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleShell from "../../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../../components/ui";
import { filterDiscordGuildChannels } from "../../../lib/discord-channel-search.mjs";
import { mergeDiscordGuilds } from "../../../lib/discord-guild-list.mjs";

export default function DiscordManualPage() {
  const [status, setStatus] = useState({ guilds: [], config: { guilds: {} } });
  const [health, setHealth] = useState({ checkedAt: null, summary: {}, guilds: [] });
  const [manualContent, setManualContent] = useState("");
  const [manualImageUrl, setManualImageUrl] = useState("");
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
      const response = await fetch("/api/discord/manual", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "频道健康检查失败。");
      const nextHealth = payload.health || { checkedAt: null, summary: {}, guilds: [] };
      setStatus(payload.status || { guilds: [], config: { guilds: {} } });
      setHealth(nextHealth);
      const sendable = new Set(nextHealth.guilds.flatMap((guild) => guild.channels || []).filter((channel) => channel.permissionsOk).map((channel) => channel.channelId));
      setManualChannelIds((current) => current.filter((channelId) => sendable.has(channelId)));
    } catch (requestError) {
      setError(requestError.message || "频道健康检查失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { checkHealth(); }, [checkHealth]);

  const availableGuilds = useMemo(() => mergeDiscordGuilds({
    healthGuilds: health.guilds,
    discoveredGuilds: status.guilds,
    configuredGuilds: Object.values(status.config?.guilds || {}),
  }), [health.guilds, status.config?.guilds, status.guilds]);
  const healthyCount = useMemo(() => availableGuilds.flatMap((guild) => guild.channels || []).filter((channel) => channel.permissionsOk).length, [availableGuilds]);
  const filteredGuilds = useMemo(() => filterDiscordGuildChannels(availableGuilds, guildSearch), [availableGuilds, guildSearch]);

  function toggleChannel(channelId) {
    setManualChannelIds((current) => current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId]);
  }

  async function publish() {
    if (!manualChannelIds.length) return setError("请至少选择一个实时检测通过的频道。");
    if (!manualContent.trim() && !manualImageUrl.trim()) return setError("请输入消息正文或图片链接。");
    setBusy(true);
    setError("");
    setNotice("");
    setManualResults([]);
    try {
      const response = await fetch("/api/discord/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channelIds: manualChannelIds, content: manualContent, imageUrl: manualImageUrl }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "信息发布失败。");
      const result = payload.result?.manualPublish || { delivered: 0, failed: 0, results: [] };
      setManualResults(result.results || []);
      setNotice(`发布完成：成功 ${result.delivered || 0} 个，失败 ${result.failed || 0} 个。`);
      if ((result.failed || 0) === 0) {
        setManualContent("");
        setManualImageUrl("");
      }
    } catch (requestError) {
      setError(requestError.message || "信息发布失败。");
    } finally {
      setBusy(false);
    }
  }

  return <ConsoleShell>
    <PageHeader title="Discord 手动信息发布" desc="Trader 可参考 Telegram 手动发布流程，填写正文或图片链接，并直接发送到已通过实时检测的频道。" action={<button type="button" onClick={checkHealth} className="rounded-lg border border-ops-line bg-white px-4 py-2 text-sm font-black">重新实时检测</button>} />
    {loading && <div className="mb-4 text-sm text-ops-muted">正在检测可发送频道…</div>}
    {notice && <div className="mb-4 rounded-lg bg-[#e6f7ef] px-4 py-3 text-sm font-bold text-ops-accent">{notice}</div>}
    {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

    <div className="grid gap-6 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
      <Card className="p-6">
        <div className="flex items-center justify-between"><h2 className="text-xl font-black">发布目标</h2><StatusPill tone={healthyCount ? "green" : "amber"}>{healthyCount} 个可发送</StatusPill></div>
        <div className="mt-5 grid gap-3">
          <Field label="搜索可发言频道"><input type="search" className={inputClass} value={guildSearch} onChange={(event) => setGuildSearch(event.target.value)} placeholder="搜索 Server 或 Channel 名称" /></Field>
          {filteredGuilds.map((guild) => <details key={guild.guildId} open={guildSearch.trim() ? true : undefined} className="rounded-lg border border-ops-line"><summary className="cursor-pointer list-none px-4 py-3 font-black">{guild.guildName} <span className="ml-2 text-xs text-ops-muted">{(guild.channels || []).filter((channel) => channel.permissionsOk).length}/{(guild.channels || []).length}</span></summary><div className="border-t border-ops-line p-3">{(guild.channels || []).map((channel) => <label key={channel.channelId} className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${channel.permissionsOk ? "hover:bg-ops-soft" : "opacity-50"}`}><span className="flex items-center gap-2"><input type="checkbox" disabled={!channel.permissionsOk} checked={manualChannelIds.includes(channel.channelId)} onChange={() => toggleChannel(channel.channelId)} />#{channel.name}</span><StatusPill tone={channel.permissionsOk ? "green" : "gray"}>{channel.permissionsOk ? "可发送" : channel.error || "权限不完整"}</StatusPill></label>)}</div></details>)}
          {!loading && availableGuilds.length === 0 && <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">暂无 Bot 可见的 Discord Server。</div>}
          {!loading && availableGuilds.length > 0 && filteredGuilds.length === 0 && <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">没有匹配的 Server 或 Channel。</div>}
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="text-xl font-black">Trader 消息</h2>
        <div className="mt-5 grid gap-4">
          <Field label="消息正文"><textarea className={`${inputClass} min-h-56 resize-y`} value={manualContent} onChange={(event) => setManualContent(event.target.value)} placeholder="输入需要发送的 Trader 信息；换行会按原格式保留。" /></Field>
          <Field label="图片链接（可选）"><input className={inputClass} value={manualImageUrl} onChange={(event) => setManualImageUrl(event.target.value)} placeholder="https://…" /></Field>
        </div>
        <div className="mt-5 rounded-lg bg-ops-soft px-4 py-3 text-sm text-ops-muted">只显示并允许选择 Bot 当前具备查看及发言权限的频道；单个目标失败不会影响其他目标。</div>
        <button type="button" disabled={busy || manualChannelIds.length === 0 || (!manualContent.trim() && !manualImageUrl.trim())} onClick={publish} className="mt-5 rounded-lg bg-ops-accent px-5 py-2.5 text-sm font-black text-white disabled:opacity-50">{busy ? "正在发布…" : `发送到 ${manualChannelIds.length} 个频道`}</button>
        {manualResults.length > 0 && <div className="mt-6 grid gap-2"><h3 className="font-black">逐目标结果</h3>{manualResults.map((result, index) => <div key={`${result.channelId}-${index}`} className="flex items-center justify-between rounded-lg border border-ops-line px-3 py-2 text-sm"><span>#{result.channelName || result.channelId}</span><StatusPill tone={result.ok ? "green" : "amber"}>{result.ok ? "成功" : result.error || "失败"}</StatusPill></div>)}</div>}
      </Card>
    </div>
  </ConsoleShell>;
}
