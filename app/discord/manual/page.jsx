"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleShell from "../../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../../components/ui";
import { filterDiscordGuildChannels } from "../../../lib/discord-channel-search.mjs";
import { mergeDiscordGuilds } from "../../../lib/discord-guild-list.mjs";

function canSendManual(channel, { hasLocalImage = false, hasImageUrl = false } = {}) {
  if (!channel?.permissionsOk) return false;
  if (hasLocalImage && channel?.canAttach === false) return false;
  if (hasImageUrl && channel?.canEmbed === false) return false;
  return true;
}

function manualChannelStatus(channel, options) {
  if (channel?.available === false || channel?.canView === false) return channel?.error || "缺少 View Channel";
  if (channel?.canSend === false) return "缺少 Send Messages";
  if (options.hasLocalImage && channel?.canAttach === false) return "缺少 Attach Files";
  if (options.hasImageUrl && channel?.canEmbed === false) return "缺少 Embed Links";
  return canSendManual(channel, options) ? "可发送" : "等待实时检测";
}

export default function DiscordManualPage() {
  const [status, setStatus] = useState({ guilds: [], config: { guilds: {} } });
  const [health, setHealth] = useState({ checkedAt: null, summary: {}, guilds: [] });
  const [manualContent, setManualContent] = useState("");
  const [manualImageUrl, setManualImageUrl] = useState("");
  const [manualImageFile, setManualImageFile] = useState(null);
  const [fileInputKey, setFileInputKey] = useState(0);
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
  const capabilityOptions = useMemo(() => ({ hasLocalImage: Boolean(manualImageFile), hasImageUrl: Boolean(manualImageUrl.trim()) }), [manualImageFile, manualImageUrl]);
  const channelMap = useMemo(() => new Map(availableGuilds.flatMap((guild) => (guild.channels || []).map((channel) => [channel.channelId, channel]))), [availableGuilds]);
  const healthyCount = useMemo(() => availableGuilds.flatMap((guild) => guild.channels || []).filter((channel) => canSendManual(channel, capabilityOptions)).length, [availableGuilds, capabilityOptions]);
  const filteredGuilds = useMemo(() => filterDiscordGuildChannels(availableGuilds, guildSearch), [availableGuilds, guildSearch]);

  useEffect(() => {
    setManualChannelIds((current) => current.filter((channelId) => canSendManual(channelMap.get(channelId), capabilityOptions)));
  }, [capabilityOptions, channelMap]);

  function toggleChannel(channelId) {
    setManualChannelIds((current) => current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId]);
  }

  async function publish() {
    if (!manualChannelIds.length) return setError("请至少选择一个实时检测通过的频道。");
    if (!manualContent.trim() && !manualImageUrl.trim() && !manualImageFile) return setError("请输入消息正文、图片链接或选择本地图片。");
    if (manualImageFile && !String(manualImageFile.type || "").startsWith("image/")) return setError("只允许上传图片文件。");
    if (manualImageFile && manualImageFile.size > 10 * 1024 * 1024) return setError("图片大小不能超过 10MB。");
    setBusy(true);
    setError("");
    setNotice("");
    setManualResults([]);
    try {
      const formData = new FormData();
      manualChannelIds.forEach((channelId) => formData.append("channelIds", channelId));
      formData.append("content", manualContent);
      formData.append("imageUrl", manualImageUrl);
      if (manualImageFile) formData.append("image", manualImageFile);
      const response = await fetch("/api/discord/manual", { method: "POST", body: formData });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "信息发布失败。");
      const result = payload.result?.manualPublish || { delivered: 0, failed: 0, results: [] };
      setManualResults(result.results || []);
      setNotice(`发布完成：成功 ${result.delivered || 0} 个，失败 ${result.failed || 0} 个。`);
      if ((result.failed || 0) === 0) {
        setManualContent("");
        setManualImageUrl("");
        setManualImageFile(null);
        setFileInputKey((current) => current + 1);
      }
    } catch (requestError) {
      setError(requestError.message || "信息发布失败。");
    } finally {
      setBusy(false);
    }
  }

  return <ConsoleShell>
    <PageHeader title="Discord 手动信息发布" desc="Trader 可填写正文、粘贴图片链接或直接选择本地图片，并发送到已通过实时检测的频道。" action={<button type="button" onClick={checkHealth} className="rounded-lg border border-ops-line bg-white px-4 py-2 text-sm font-black">重新实时检测</button>} />
    {loading && <div className="mb-4 text-sm text-ops-muted">正在检测可发送频道…</div>}
    {notice && <div className="mb-4 rounded-lg bg-[#e6f7ef] px-4 py-3 text-sm font-bold text-ops-accent">{notice}</div>}
    {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

    <div className="grid gap-6 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
      <Card className="p-6">
        <div className="flex items-center justify-between"><h2 className="text-xl font-black">发布目标</h2><StatusPill tone={healthyCount ? "green" : "amber"}>{healthyCount} 个可发送</StatusPill></div>
        <div className="mt-5 grid gap-3">
          <Field label="搜索可发言频道"><input type="search" className={inputClass} value={guildSearch} onChange={(event) => setGuildSearch(event.target.value)} placeholder="搜索 Server 或 Channel 名称" /></Field>
          {filteredGuilds.map((guild) => <details key={guild.guildId} open={guildSearch.trim() ? true : undefined} className="rounded-lg border border-ops-line"><summary className="cursor-pointer list-none px-4 py-3 font-black">{guild.guildName} <span className="ml-2 text-xs text-ops-muted">{(guild.channels || []).filter((channel) => canSendManual(channel, capabilityOptions)).length}/{(guild.channels || []).length}</span></summary><div className="border-t border-ops-line p-3">{(guild.channels || []).map((channel) => { const selectable = canSendManual(channel, capabilityOptions); return <label key={channel.channelId} className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${selectable ? "hover:bg-ops-soft" : "opacity-50"}`}><span className="flex items-center gap-2"><input type="checkbox" disabled={!selectable} checked={manualChannelIds.includes(channel.channelId)} onChange={() => toggleChannel(channel.channelId)} />#{channel.name}</span><StatusPill tone={selectable ? "green" : "gray"}>{manualChannelStatus(channel, capabilityOptions)}</StatusPill></label>; })}</div></details>)}
          {!loading && availableGuilds.length === 0 && <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">暂无 Bot 可见的 Discord Server。</div>}
          {!loading && availableGuilds.length > 0 && filteredGuilds.length === 0 && <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">没有匹配的 Server 或 Channel。</div>}
        </div>
      </Card>

      <Card className="p-6">
        <h2 className="text-xl font-black">Trader 消息</h2>
        <div className="mt-5 grid gap-4">
          <Field label="消息正文"><textarea className={`${inputClass} min-h-56 resize-y`} value={manualContent} onChange={(event) => setManualContent(event.target.value)} placeholder="输入需要发送的 Trader 信息；换行会按原格式保留。" /></Field>
          <Field label="本地图片（可选，最大 10MB）"><input key={fileInputKey} id="manualImageFile" name="manualImageFile" type="file" accept="image/*" className={inputClass} onChange={(event) => { const file = event.target.files?.[0] || null; setManualImageFile(file); if (file) setManualImageUrl(""); }} /></Field>
          <Field label="图片链接（可选）"><input className={inputClass} value={manualImageUrl} onChange={(event) => { setManualImageUrl(event.target.value); if (event.target.value) { setManualImageFile(null); setFileInputKey((current) => current + 1); } }} placeholder="https://…" /></Field>
        </div>
        <div className="mt-5 rounded-lg bg-ops-soft px-4 py-3 text-sm text-ops-muted">文字需要 View Channel + Send Messages；本地图片还需要 Attach Files；图片链接还需要 Embed Links。选择内容后，列表会实时只允许勾选满足本次发布权限的 Channel。</div>
        <button type="button" disabled={busy || manualChannelIds.length === 0 || (!manualContent.trim() && !manualImageUrl.trim() && !manualImageFile)} onClick={publish} className="mt-5 rounded-lg bg-ops-accent px-5 py-2.5 text-sm font-black text-white disabled:opacity-50">{busy ? "正在发布…" : `发送到 ${manualChannelIds.length} 个频道`}</button>
        {manualResults.length > 0 && <div className="mt-6 grid gap-2"><h3 className="font-black">逐目标结果</h3>{manualResults.map((result, index) => <div key={`${result.channelId}-${index}`} className="flex items-center justify-between rounded-lg border border-ops-line px-3 py-2 text-sm"><span>#{result.channelName || result.channelId}</span><StatusPill tone={result.ok ? "green" : "amber"}>{result.ok ? "成功" : result.error || "失败"}</StatusPill></div>)}</div>}
      </Card>
    </div>
  </ConsoleShell>;
}
