"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleShell from "../../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../../components/ui";

export default function DiscordManualPage() {
  const [health, setHealth] = useState({ checkedAt: null, summary: {}, guilds: [] });
  const [manualChannelIds, setManualChannelIds] = useState([]);
  const [manualContent, setManualContent] = useState("");
  const [manualImageUrl, setManualImageUrl] = useState("");
  const [manualResults, setManualResults] = useState([]);
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
      const sendable = new Set(next.guilds.flatMap((guild) => guild.channels || []).filter((channel) => channel.canSend).map((channel) => channel.channelId));
      setManualChannelIds((current) => current.filter((channelId) => sendable.has(channelId)));
    } catch (requestError) {
      setError(requestError.message || "频道健康检查失败。");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { checkHealth(); }, [checkHealth]);

  const healthyCount = useMemo(() => health.guilds.flatMap((guild) => guild.channels || []).filter((channel) => channel.canSend).length, [health.guilds]);

  function toggleChannel(channelId) {
    setManualChannelIds((current) => current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId]);
  }

  async function publish() {
    if (!manualChannelIds.length) return setError("请至少选择一个健康且可发送的频道。");
    if (!manualContent.trim() && !manualImageUrl.trim()) return setError("请输入消息内容或图片链接。");
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/discord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "manual-publish", channelIds: manualChannelIds, content: manualContent, imageUrl: manualImageUrl }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "手动信息发布失败。");
      const result = payload.result?.manualPublish || { delivered: 0, failed: 0, results: [] };
      setManualResults(result.results || []);
      setNotice(`发布完成：成功 ${result.delivered} 个，失败 ${result.failed} 个。`);
    } catch (requestError) {
      setError(requestError.message || "手动信息发布失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConsoleShell>
      <PageHeader title="Discord 手动信息发布" desc="Server 默认折叠；展开后只能选择本次实时检查确认可发送的 Channel。" action={<button type="button" onClick={checkHealth} className="rounded-lg border border-ops-line bg-white px-4 py-2 text-sm font-black">重新实时检测</button>} />
      {loading && <div className="mb-4 text-sm text-ops-muted">正在检测可发送频道…</div>}
      {notice && <div className="mb-4 rounded-lg bg-[#e6f7ef] px-4 py-3 text-sm font-bold text-ops-accent">{notice}</div>}
      {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

      <div className="grid gap-6 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
        <Card className="p-6">
          <div className="flex items-center justify-between"><h2 className="text-xl font-black">发布目标</h2><StatusPill tone={healthyCount ? "green" : "amber"}>{healthyCount} 个可发送</StatusPill></div>
          <div className="mt-5 grid gap-3">
            {health.guilds.map((guild) => <details key={guild.guildId} className="rounded-lg border border-ops-line"><summary className="cursor-pointer list-none px-4 py-3 font-black">{guild.guildName} <span className="ml-2 text-xs text-ops-muted">{(guild.channels || []).filter((channel) => channel.canSend).length}/{(guild.channels || []).length}</span></summary><div className="border-t border-ops-line p-3">{(guild.channels || []).map((channel) => <label key={channel.channelId} className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${channel.canSend ? "hover:bg-ops-soft" : "opacity-50"}`}><span className="flex items-center gap-2"><input type="checkbox" disabled={!channel.canSend} checked={manualChannelIds.includes(channel.channelId)} onChange={() => toggleChannel(channel.channelId)} />#{channel.name}</span><StatusPill tone={channel.canSend ? "green" : "gray"}>{channel.canSend ? "可发送" : channel.error || "无权限"}</StatusPill></label>)}</div></details>)}
            {!loading && health.guilds.length === 0 && <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">暂无已初始化的 Discord Server。</div>}
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="text-xl font-black">消息内容</h2>
          <div className="mt-5 grid gap-4">
            <Field label="正文"><textarea rows={10} className={`${inputClass} py-3`} value={manualContent} onChange={(event) => setManualContent(event.target.value)} placeholder="输入要发布的完整内容" /></Field>
            <Field label="图片链接（可选）"><input className={inputClass} value={manualImageUrl} onChange={(event) => setManualImageUrl(event.target.value)} placeholder="https://…" /></Field>
          </div>
          <button type="button" disabled={busy || manualChannelIds.length === 0} onClick={publish} className="mt-5 rounded-lg bg-ops-accent px-5 py-2.5 text-sm font-black text-white disabled:opacity-50">发送到 {manualChannelIds.length} 个频道</button>

          {manualResults.length > 0 && <div className="mt-6 grid gap-2"><h3 className="font-black">逐目标结果</h3>{manualResults.map((result, index) => <div key={`${result.channelId}-${index}`} className="flex items-center justify-between rounded-lg border border-ops-line px-3 py-2 text-sm"><span>#{result.channelName || result.channelId}</span><StatusPill tone={result.ok ? "green" : "amber"}>{result.ok ? "成功" : result.error || "失败"}</StatusPill></div>)}</div>}
        </Card>
      </div>
    </ConsoleShell>
  );
}
