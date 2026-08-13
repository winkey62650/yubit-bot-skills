"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import ConsoleShell from "../../components/ConsoleShell";
import { Card, Field, PageHeader, StatusPill, inputClass } from "../../components/ui";

const TASKS = [
  { name: "Daily Events", detail: "每日市场事件：独立海报 + 英文正文" },
  { name: "Daily Analysis", detail: "每日行情分析：图文合并发布" },
  { name: "Whale Signals", detail: "巨鲸与大户挂单：英文图文" },
];

export default function DiscordDistributionPage() {
  const [status, setStatus] = useState({ config: { guilds: {}, routes: [], demoGuildId: "", syncEnabled: false } });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [demoGuildId, setDemoGuildId] = useState("");
  const [syncEnabled, setSyncEnabled] = useState(false);
  const [health, setHealth] = useState({ checkedAt: null, summary: {}, guilds: [] });
  const [checkingHealth, setCheckingHealth] = useState(true);
  const [directChannelIds, setDirectChannelIds] = useState([]);
  const [directContent, setDirectContent] = useState("");
  const [directImageUrl, setDirectImageUrl] = useState("");
  const [directResults, setDirectResults] = useState([]);

  const applyStatus = useCallback((payload) => {
    const config = { guilds: {}, routes: [], demoGuildId: "", syncEnabled: false, ...(payload?.config || {}) };
    setStatus({ ...payload, config });
    setDemoGuildId(config.demoGuildId || "");
    setSyncEnabled(config.syncEnabled === true);
  }, []);

  const load = useCallback(async () => {
    try {
      setError("");
      const response = await fetch("/api/discord", { cache: "no-store" });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "Discord 内容分发配置读取失败。");
      applyStatus(payload);
    } catch (requestError) {
      setError(requestError.message || "Discord 内容分发配置读取失败。");
    } finally {
      setLoading(false);
    }
  }, [applyStatus]);

  const checkHealth = useCallback(async () => {
    setCheckingHealth(true);
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
      setDirectChannelIds((current) => current.filter((channelId) => sendable.has(channelId)));
    } catch (requestError) {
      setError(requestError.message || "频道健康检查失败。");
    } finally {
      setCheckingHealth(false);
    }
  }, []);

  useEffect(() => {
    load();
    checkHealth();
  }, [checkHealth, load]);

  const guilds = useMemo(() => Object.values(status.config.guilds || {}).sort(
    (left, right) => String(left.guildName).localeCompare(String(right.guildName)),
  ), [status.config.guilds]);
  const healthyCount = useMemo(() => health.guilds.flatMap((guild) => guild.channels || []).filter((channel) => channel.canSend).length, [health.guilds]);

  function toggleDirectChannel(channelId) {
    setDirectChannelIds((current) => current.includes(channelId) ? current.filter((id) => id !== channelId) : [...current, channelId]);
  }

  async function directPublish() {
    if (!directChannelIds.length) return setError("请至少选择一个健康且可发送的频道。");
    if (!directContent.trim() && !directImageUrl.trim()) return setError("请输入发布内容或图片链接。");
    setBusy(true);
    setError("");
    setNotice("");
    setDirectResults([]);
    try {
      const response = await fetch("/api/discord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "direct-publish", channelIds: directChannelIds, content: directContent, imageUrl: directImageUrl }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "内容直接发布失败。");
      const result = payload.result?.directPublish || { delivered: 0, failed: 0, results: [] };
      setDirectResults(result.results || []);
      setNotice(`直接发布完成：成功 ${result.delivered} 个，失败 ${result.failed} 个。`);
    } catch (requestError) {
      setError(requestError.message || "内容直接发布失败。");
    } finally {
      setBusy(false);
    }
  }

  async function saveSettings() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch("/api/discord", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "settings", demoGuildId, syncEnabled }),
      });
      const payload = await response.json();
      if (!response.ok || !payload.ok) throw new Error(payload.error || "同步设置保存失败。");
      applyStatus(payload);
      setNotice("Demo Server 与同步开关已保存。");
    } catch (requestError) {
      setError(requestError.message || "同步设置保存失败。");
    } finally {
      setBusy(false);
    }
  }

  return (
    <ConsoleShell>
      <PageHeader
        title="Discord 内容分发中心"
        desc="支持内容直接发布、自动发布和 Demo → 目标同步；直接发布无需经过 Demo。"
        action={<Link href="/distribution?view=automation&platform=discord" className="rounded-lg bg-ops-ink px-4 py-2 text-sm font-black text-white">管理自动发布任务</Link>}
      />
      {loading && <div className="mb-4 text-sm text-ops-muted">正在读取分发配置…</div>}
      {notice && <div className="mb-4 rounded-lg bg-[#e6f7ef] px-4 py-3 text-sm font-bold text-ops-accent">{notice}</div>}
      {error && <div className="mb-4 rounded-lg bg-red-50 px-4 py-3 text-sm font-bold text-red-700">{error}</div>}

      <Card className="p-6">
        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
          <div><h2 className="text-xl font-black">直接发布到任意 Server / Channel</h2><p className="mt-2 text-sm text-ops-muted">无需经过 Demo：填写内容，展开 Server 并选择一个或多个可发送 Channel 即可直接分发。</p></div>
          <button type="button" onClick={checkHealth} disabled={checkingHealth || busy} className="rounded-lg border border-ops-line bg-white px-4 py-2 text-sm font-black disabled:opacity-50">{checkingHealth ? "正在检测…" : "重新实时检测"}</button>
        </div>
        <div className="mt-6 grid gap-6 xl:grid-cols-[minmax(320px,0.8fr)_minmax(0,1.2fr)]">
          <div>
            <div className="flex items-center justify-between"><h3 className="font-black">发布频道</h3><StatusPill tone={healthyCount ? "green" : "amber"}>{healthyCount} 个可发送</StatusPill></div>
            <div className="mt-4 grid gap-3">
              {health.guilds.map((guild) => <details key={guild.guildId} className="rounded-lg border border-ops-line"><summary className="cursor-pointer list-none px-4 py-3 font-black">{guild.guildName} <span className="ml-2 text-xs text-ops-muted">{(guild.channels || []).filter((channel) => channel.canSend).length}/{(guild.channels || []).length}</span></summary><div className="border-t border-ops-line p-3">{(guild.channels || []).map((channel) => <label key={channel.channelId} className={`flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-sm ${channel.canSend ? "hover:bg-ops-soft" : "opacity-50"}`}><span className="flex items-center gap-2"><input type="checkbox" disabled={!channel.canSend} checked={directChannelIds.includes(channel.channelId)} onChange={() => toggleDirectChannel(channel.channelId)} />#{channel.name}</span><StatusPill tone={channel.canSend ? "green" : "gray"}>{channel.canSend ? "可发送" : channel.error || "无权限"}</StatusPill></label>)}</div></details>)}
              {!checkingHealth && health.guilds.length === 0 && <div className="rounded-lg border border-dashed border-ops-line p-4 text-sm text-ops-muted">暂无已初始化且可检测的 Discord Server。</div>}
            </div>
          </div>
          <div>
            <h3 className="font-black">选择发布内容</h3>
            <div className="mt-4 grid gap-4">
              <Field label="正文"><textarea rows={9} className={`${inputClass} py-3`} value={directContent} onChange={(event) => setDirectContent(event.target.value)} placeholder="输入要直接发布的完整内容" /></Field>
              <Field label="图片链接（可选）"><input className={inputClass} value={directImageUrl} onChange={(event) => setDirectImageUrl(event.target.value)} placeholder="https://…" /></Field>
            </div>
            <button type="button" disabled={busy || directChannelIds.length === 0} onClick={directPublish} className="mt-5 rounded-lg bg-ops-accent px-5 py-2.5 text-sm font-black text-white disabled:opacity-50">直接发送到 {directChannelIds.length} 个频道</button>
            {directResults.length > 0 && <div className="mt-6 grid gap-2"><h3 className="font-black">逐目标发布结果</h3>{directResults.map((result, index) => <div key={`${result.channelId}-${index}`} className="flex items-center justify-between rounded-lg border border-ops-line px-3 py-2 text-sm"><span>#{result.channelName || result.channelId}</span><StatusPill tone={result.ok ? "green" : "amber"}>{result.ok ? "成功" : result.error || "失败"}</StatusPill></div>)}</div>}
          </div>
        </div>
      </Card>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {TASKS.map((task) => <Card key={task.name} className="p-5"><div className="flex items-center justify-between gap-3"><h2 className="font-black">{task.name}</h2><StatusPill tone="green">模板共用</StatusPill></div><p className="mt-3 text-sm leading-6 text-ops-muted">{task.detail}</p><Link href="/distribution?view=automation&platform=discord" className="mt-4 inline-flex text-sm font-black text-ops-accent">查看模板与目标 →</Link></Card>)}
      </div>

      <Card className="mt-6 p-6">
        <h2 className="text-xl font-black">Demo → 目标同步规则</h2>
        <p className="mt-2 text-sm text-ops-muted">来源和目标均按稳定的 Server ID + Channel ID 保存，不依赖频道名称猜测。</p>
        <div className="mt-5 grid gap-4 md:grid-cols-[1fr_auto] md:items-end">
          <Field label="Discord Demo Server"><select className={inputClass} value={demoGuildId} onChange={(event) => setDemoGuildId(event.target.value)}><option value="">请选择已初始化 Server</option>{guilds.map((guild) => <option key={guild.guildId} value={guild.guildId}>{guild.guildName}</option>)}</select></Field>
          <label className="flex min-h-10 items-center gap-2 rounded-lg border border-ops-line px-4 text-sm font-bold"><input type="checkbox" checked={syncEnabled} onChange={(event) => setSyncEnabled(event.target.checked)} />启用 Discord 同步</label>
        </div>
        <button type="button" disabled={busy} onClick={saveSettings} className="mt-4 rounded-lg bg-ops-accent px-4 py-2 text-sm font-black text-white disabled:opacity-50">保存基础设置</button>

        <div className="mt-6 grid gap-3">
          {(status.config.routes || []).length === 0 ? <div className="rounded-lg border border-dashed border-ops-line p-5 text-sm text-ops-muted">暂无同步规则。请先完成 Demo Server 初始化，再创建 Channel 映射。</div> : status.config.routes.map((route, index) => <div key={route.id || `${route.sourceChannelId}-${route.targetChannelId}-${index}`} className="flex flex-col gap-2 rounded-lg border border-ops-line p-4 md:flex-row md:items-center md:justify-between"><div className="text-sm font-bold">{route.sourceGuildName || route.sourceGuildId} / #{route.sourceChannelName || route.sourceChannelId} → {route.targetGuildName || route.targetGuildId} / #{route.targetChannelName || route.targetChannelId}</div><StatusPill tone={route.enabled === false ? "gray" : "green"}>{route.enabled === false ? "已暂停" : "运行中"}</StatusPill></div>)}
        </div>
      </Card>
    </ConsoleShell>
  );
}
